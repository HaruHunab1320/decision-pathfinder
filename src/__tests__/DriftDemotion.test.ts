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
import { createGuidedDecisionMaker } from '../recommendation/GuidedDecisionMaker.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';

/**
 * WAVE 2 — Improvement 1: drift demotion.
 *
 * An edge whose RECENT success rate has collapsed relative to its lifetime rate
 * must be demoted below the 0.6 LLM-skip override instead of coasting on a
 * high age-decayed score until decay catches up.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

function node(id: string): INode {
  return { id, type: 'test', label: id, metadata: {} };
}
function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}

/** A session of records with a fixed age (days) and a final status. */
function session(
  nodeIds: string[],
  finalStatus: 'success' | 'failure',
  ageDays: number,
  now: number,
): EnhancedPathRecord[] {
  const base = now - ageDays * DAY_MS;
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

/** start → [A → end | B → end] */
function buildTree(): DecisionTree {
  const tree = new DecisionTree();
  for (const id of ['start', 'A', 'B', 'end']) tree.addNode(node(id));
  tree.addEdge(edge('e-start-A', 'start', 'A'));
  tree.addEdge(edge('e-start-B', 'start', 'B'));
  tree.addEdge(edge('e-A-end', 'A', 'end'));
  tree.addEdge(edge('e-B-end', 'B', 'end'));
  return tree;
}

/**
 * A formerly-excellent edge whose last 3 runs all failed.
 * 20 traversals of start→A: 17 old successes, then 3 recent failures.
 * lifetime = 0.85, recent-5 = 0.4 → collapse of 0.45 > 0.2 threshold.
 */
function collapsedHistory(now: number): EnhancedPathRecord[][] {
  const sessions: EnhancedPathRecord[][] = [];
  for (let i = 0; i < 17; i++) {
    // ages 10 → 2 days: comfortably inside the 30-day half-life
    sessions.push(session(['start', 'A', 'end'], 'success', 10 - i * 0.5, now));
  }
  for (let i = 0; i < 3; i++) {
    sessions.push(
      session(['start', 'A', 'end'], 'failure', 0.75 - i * 0.25, now),
    );
  }
  return sessions;
}

describe('WAVE 2 — drift demotion', () => {
  it('demotes an edge whose recent success rate collapsed, below the 0.6 override', () => {
    const now = Date.now();
    const sessions = collapsedHistory(now);
    const engine = new RecommendationEngine(buildTree(), fakeTracker(sessions));

    const rec = engine.getEdgeRecommendation('start', now);
    expect(rec).not.toBeNull();
    expect(rec!.recommendedEdgeId).toBe('e-start-A');
    expect(rec!.drifted).toBe(true);
    // Clamped to the demotion ceiling → cannot trigger the LLM-skip override…
    expect(rec!.confidence).toBeLessThan(0.6);
    expect(rec!.confidence).toBeLessThanOrEqual(0.5);
    // …but still above the 0.2 prompt-hint tier: demote, don't erase.
    expect(rec!.confidence).toBeGreaterThanOrEqual(0.2);
    expect(rec!.reasoning).toContain('DRIFT');
  });

  it('without demotion the same history WOULD have skipped the LLM (proves the change bites)', () => {
    const now = Date.now();
    const sessions = collapsedHistory(now);
    const engine = new RecommendationEngine(
      buildTree(),
      fakeTracker(sessions),
      {
        driftDemotion: false,
      },
    );

    const rec = engine.getEdgeRecommendation('start', now)!;
    // Detection still reported, but the score is untouched and over the line.
    expect(rec.drifted).toBe(true);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('a healthy sibling edge overtakes the drifted one', () => {
    const now = Date.now();
    const sessions = collapsedHistory(now);
    // 7 clean recent successes through B → ~0.7 confidence, above the 0.5 ceiling
    for (let i = 0; i < 7; i++) {
      sessions.push(session(['start', 'B', 'end'], 'success', 1, now));
    }

    const engine = new RecommendationEngine(buildTree(), fakeTracker(sessions));
    const rec = engine.getEdgeRecommendation('start', now)!;
    expect(rec.recommendedEdgeId).toBe('e-start-B');
    expect(rec.drifted).toBe(false);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);

    const drifted = rec.alternativeEdges.find((a) => a.edgeId === 'e-start-A');
    expect(drifted?.drifted).toBe(true);
    expect(drifted?.confidence).toBeLessThanOrEqual(0.5);

    // With demotion off, the stale A edge would still have won.
    const noDemotion = new RecommendationEngine(
      buildTree(),
      fakeTracker(sessions),
      { driftDemotion: false },
    );
    expect(
      noDemotion.getEdgeRecommendation('start', now)!.recommendedEdgeId,
    ).toBe('e-start-A');
  });

  it('a steady high-performing edge is untouched', () => {
    const now = Date.now();
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(['start', 'A', 'end'], 'success', i * 0.1, now),
    );
    const engine = new RecommendationEngine(buildTree(), fakeTracker(sessions));
    const rec = engine.getEdgeRecommendation('start', now)!;
    expect(rec.drifted).toBe(false);
    expect(rec.confidence).toBeCloseTo(1, 2);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('does not demote below driftMinRuns — a couple of unlucky runs are not drift', () => {
    const now = Date.now();
    // 4 runs only (< default minRuns of 5), the newest a failure.
    const sessions = [
      session(['start', 'A', 'end'], 'success', 3, now),
      session(['start', 'A', 'end'], 'success', 2, now),
      session(['start', 'A', 'end'], 'success', 1, now),
      session(['start', 'A', 'end'], 'failure', 0.5, now),
    ];
    const engine = new RecommendationEngine(buildTree(), fakeTracker(sessions));
    expect(engine.getEdgeRecommendation('start', now)!.drifted).toBe(false);
  });

  it('thresholds are configurable', () => {
    const now = Date.now();
    const sessions = collapsedHistory(now);

    // A tolerant threshold (0.9) declines to call this drift…
    const tolerant = new RecommendationEngine(
      buildTree(),
      fakeTracker(sessions),
      { driftThreshold: 0.9 },
    );
    const tolerantRec = tolerant.getEdgeRecommendation('start', now)!;
    expect(tolerantRec.drifted).toBe(false);
    expect(tolerantRec.confidence).toBeGreaterThanOrEqual(0.6);

    // …and the ceiling is tunable for stricter deployments.
    const strict = new RecommendationEngine(
      buildTree(),
      fakeTracker(sessions),
      {
        driftDemotedCeiling: 0.1,
      },
    );
    expect(
      strict.getEdgeRecommendation('start', now)!.confidence,
    ).toBeLessThanOrEqual(0.1);
  });

  it('a drifted edge does NOT trigger the LLM-skip override end to end', async () => {
    const now = Date.now();
    const tree = buildTree();
    const sessions = collapsedHistory(now);

    const calls: DecisionContext[] = [];
    const inner: IDecisionMaker = {
      async decide(context) {
        calls.push(context);
        return {
          chosenEdgeId: context.availableEdges[0]!.id,
          reasoning: 'llm',
        };
      },
    };

    const context: DecisionContext = {
      currentNodeId: 'start',
      currentNode: tree.getNode('start')!,
      availableEdges: tree.getOutgoingEdges('start'),
      availableNextNodes: [tree.getNode('A')!, tree.getNode('B')!],
      pathHistory: ['start'],
      metadata: {},
    };

    const drifting = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(sessions)),
      inner,
    );
    const result = await drifting.decide(context);
    // The LLM was consulted, and got the demoted edge only as a hint.
    expect(calls).toHaveLength(1);
    expect(result.reasoning).toBe('llm');
    expect(
      (calls[0]!.metadata.recommendation as { suggestedEdgeId: string })
        .suggestedEdgeId,
    ).toBe('e-start-A');

    // Same history with demotion disabled → the LLM call is skipped.
    calls.length = 0;
    const undemoted = createGuidedDecisionMaker(
      new RecommendationEngine(tree, fakeTracker(sessions), {
        driftDemotion: false,
      }),
      inner,
    );
    const overridden = await undemoted.decide(context);
    expect(calls).toHaveLength(0);
    expect(overridden.chosenEdgeId).toBe('e-start-A');
    expect(overridden.reasoning).toContain('Override');
  });
});
