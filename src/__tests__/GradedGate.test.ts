import { describe, expect, it } from 'vitest';
import type { DecisionContext } from '../adapters/types.js';
import { DecisionTree } from '../core/DecisionTree.js';
import type {
  EnhancedPathRecord,
  IEdge,
  IEnhancedPathTracker,
  INode,
} from '../core/interfaces.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import {
  createGuidedDecisionMaker,
  type GradedSignalInput,
} from '../recommendation/GuidedDecisionMaker.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';

/**
 * WAVE 2 — Improvement 2: the OPT-IN graded gate.
 *
 * Default: a >=0.6 history confidence skips the branch-point LLM call on its
 * own (unchanged). Opt in with a `gradedSignal` and the skip additionally
 * requires `combine([history, signal], 'min') >= 0.6`.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

function node(id: string): INode {
  return { id, type: 'test', label: id, metadata: {} };
}
function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}
function session(
  nodeIds: string[],
  finalStatus: 'success' | 'failure',
  ageDays: number,
): EnhancedPathRecord[] {
  const base = Date.now() - ageDays * DAY_MS;
  return nodeIds.map((nodeId, i) => ({
    nodeId,
    timestamp: base + i,
    metadata: {},
    status: i === nodeIds.length - 1 ? finalStatus : ('success' as const),
  }));
}
function fakeTracker(sessions: EnhancedPathRecord[][]): IEnhancedPathTracker {
  return {
    getAllSessions: () => sessions,
    recordVisit: () => {},
    getPath: () => [],
    getVisitedNodeIds: () => [],
    reset: () => {},
    recordEnhancedVisit: () => {},
    getEnhancedPath: () => [],
    getSuccessRate: () => 0,
    getFailedNodes: () => [],
    getNodeVisitCount: () => 0,
    getAveragePathLength: () => 0,
    startSession: () => {},
    endSession: () => {},
  };
}

function buildTree(): DecisionTree {
  const tree = new DecisionTree();
  for (const id of ['start', 'A', 'B', 'end']) tree.addNode(node(id));
  tree.addEdge(edge('e-start-A', 'start', 'A'));
  tree.addEdge(edge('e-start-B', 'start', 'B'));
  tree.addEdge(edge('e-A-end', 'A', 'end'));
  tree.addEdge(edge('e-B-end', 'B', 'end'));
  return tree;
}

function contextFor(tree: DecisionTree): DecisionContext {
  return {
    currentNodeId: 'start',
    currentNode: tree.getNode('start')!,
    availableEdges: tree.getOutgoingEdges('start'),
    availableNextNodes: [tree.getNode('A')!, tree.getNode('B')!],
    pathHistory: ['start'],
    metadata: {},
  };
}

/** An inner "LLM" that just records that it was called. */
function recordingInner(): IDecisionMaker & { calls: DecisionContext[] } {
  const calls: DecisionContext[] = [];
  return {
    calls,
    async decide(context) {
      calls.push(context);
      return { chosenEdgeId: context.availableEdges[0]!.id, reasoning: 'llm' };
    },
  };
}

/** 12 clean recent successes through A → confidence 1.0, not drifted. */
function confidentHistory(): EnhancedPathRecord[][] {
  return Array.from({ length: 12 }, (_, i) =>
    session(['start', 'A', 'end'], 'success', i * 0.1),
  );
}

/** 3 successes only → sample factor 0.3 → confidence ~0.3 (hint tier). */
function thinHistory(): EnhancedPathRecord[][] {
  return Array.from({ length: 3 }, (_, i) =>
    session(['start', 'A', 'end'], 'success', i * 0.1),
  );
}

describe('WAVE 2 — graded gate (opt-in)', () => {
  it('DEFAULT: no graded signal → history alone still skips the LLM', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
    );

    const result = await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(0);
    expect(result.chosenEdgeId).toBe('e-start-A');
    expect(result.reasoning).toBe('Override (confidence: 100%)');
  });

  it('DEFAULT: medium confidence still hints the LLM, low confidence passes through', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(thinHistory())),
      inner,
    );

    await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.metadata.recommendation).toMatchObject({
      suggestedEdgeId: 'e-start-A',
    });
  });

  it('ENABLED: a strong second signal still lets the skip happen (min of both)', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      { gradedSignal: () => 0.9 },
    );

    const result = await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(0);
    // min(1.0, 0.9) = 0.9 → still over the 0.6 bar
    expect(result.reasoning).toBe('Override (graded min: 90%, history: 100%)');
  });

  it('ENABLED: a weak second signal blocks the skip — history cannot skip unilaterally', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const blocked: string[] = [];
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      {
        gradedSignal: () => ({
          confidence: 0.3,
          detail: 'preflight check failed',
        }),
        onGateBlocked: (d) => blocked.push(d),
      },
    );

    const result = await dm.decide(contextFor(tree));
    // Fell through to the LLM, with the prior demoted to a hint.
    expect(inner.calls).toHaveLength(1);
    expect(result.reasoning).toBe('llm');
    expect(inner.calls[0]!.metadata.recommendation).toMatchObject({
      suggestedEdgeId: 'e-start-A',
      confidence: 1,
    });
    expect(blocked[0]).toContain('preflight check failed');
  });

  it('ENABLED: min-combine, not mean — a 100% signal cannot rescue a sub-threshold history', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    // 5 successes → sample 0.5 → confidence ~0.5, under the 0.6 override.
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session(['start', 'A', 'end'], 'success', i * 0.1),
    );
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(sessions)),
      inner,
      { gradedSignal: () => 1 },
    );

    await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(1); // mean(0.5, 1.0) would have skipped
  });

  it('ENABLED: the signal is consulted only when history alone would have skipped', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const seen: GradedSignalInput[] = [];
    const signal = (input: GradedSignalInput) => {
      seen.push(input);
      return 1;
    };

    // Thin history → never reaches the gate.
    await createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(thinHistory())),
      inner,
      { gradedSignal: signal },
    ).decide(contextFor(tree));
    expect(seen).toHaveLength(0);

    // Confident history → gate consulted exactly once, with the full context.
    await createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      { gradedSignal: signal },
    ).decide(contextFor(tree));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.context.currentNodeId).toBe('start');
    expect(seen[0]!.recommendation.recommendedEdgeId).toBe('e-start-A');
  });

  it('ENABLED: a throwing signal fails CLOSED (falls back to the LLM)', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      {
        gradedSignal: () => {
          throw new Error('probe unavailable');
        },
      },
    );

    await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(1);
  });

  it('ENABLED: async signals are awaited', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      { gradedSignal: async () => ({ confidence: 0.75 }) },
    );

    const result = await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(0);
    expect(result.reasoning).toContain('graded min: 75%');
  });

  it('thresholds are configurable and the recommended edge must still be available', async () => {
    const tree = buildTree();
    const inner = recordingInner();
    const dm = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner,
      { overrideThreshold: 0.95, gradedSignal: () => 0.9 },
    );
    await dm.decide(contextFor(tree));
    expect(inner.calls).toHaveLength(1); // min 0.9 < 0.95

    // Recommended edge missing from the live branch → never overrides.
    const inner2 = recordingInner();
    const dm2 = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(confidentHistory())),
      inner2,
    );
    const ctx = contextFor(tree);
    await dm2.decide({
      ...ctx,
      availableEdges: ctx.availableEdges.filter((e) => e.id !== 'e-start-A'),
    });
    expect(inner2.calls).toHaveLength(1);
  });
});
