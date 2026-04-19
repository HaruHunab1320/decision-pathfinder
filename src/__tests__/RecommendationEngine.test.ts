import { beforeEach, describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge, INode } from '../core/interfaces.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';
import { PathTracker } from '../tracking/PathTracker.js';

function node(id: string, label?: string): INode {
  return { id, type: 'test', label: label ?? id, metadata: {} };
}

function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}

/**
 * Helper: simulate a session by recording visits on a tracker.
 * The finalStatus is applied to the last recorded visit.
 */
function recordSession(
  tracker: PathTracker,
  nodeIds: string[],
  finalStatus: 'success' | 'failure',
): void {
  tracker.startSession();
  for (let i = 0; i < nodeIds.length; i++) {
    const isLast = i === nodeIds.length - 1;
    tracker.recordEnhancedVisit(nodeIds[i]!, isLast ? finalStatus : 'success');
  }
  tracker.endSession();
}

describe('RecommendationEngine — efficiency-weighted confidence', () => {
  let tree: DecisionTree;
  let tracker: PathTracker;

  beforeEach(() => {
    tree = new DecisionTree();
    tracker = new PathTracker();
  });

  it('prefers shorter successful paths over longer ones at the same node', () => {
    // Tree: start → [short | long]
    //   short: start → A → end        (3 nodes)
    //   long:  start → B → C → D → end (5 nodes)
    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('B'));
    tree.addNode(node('C'));
    tree.addNode(node('D'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-B', 'start', 'B'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-B-C', 'B', 'C'));
    tree.addEdge(edge('e-C-D', 'C', 'D'));
    tree.addEdge(edge('e-D-end', 'D', 'end'));

    // Both paths succeed equally often
    for (let i = 0; i < 5; i++) {
      recordSession(tracker, ['start', 'A', 'end'], 'success');
      recordSession(tracker, ['start', 'B', 'C', 'D', 'end'], 'success');
    }

    const engine = new RecommendationEngine(tree, tracker);
    const rec = engine.getEdgeRecommendation('start');

    expect(rec).not.toBeNull();
    expect(rec!.recommendedEdgeId).toBe('e-start-A'); // shorter path
    expect(rec!.confidence).toBeGreaterThan(0);
  });

  it('short path confidence equals base (efficiency factor = 1.0)', () => {
    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'A'));
    tree.addEdge(edge('e2', 'A', 'end'));

    for (let i = 0; i < 10; i++) {
      recordSession(tracker, ['start', 'A', 'end'], 'success');
    }

    const engine = new RecommendationEngine(tree, tracker);
    const rec = engine.getEdgeRecommendation('start');

    // 100% success × 1.0 sample factor (10/10) × 1.0 efficiency = 1.0
    expect(rec!.confidence).toBeCloseTo(1.0, 2);
  });

  it('longer path gets reduced confidence proportional to length ratio', () => {
    // Shortest: 3 nodes. This path: 6 nodes. Efficiency = 3/6 = 0.5
    tree.addNode(node('start'));
    tree.addNode(node('short'));
    tree.addNode(node('end'));
    tree.addNode(node('l1'));
    tree.addNode(node('l2'));
    tree.addNode(node('l3'));
    tree.addNode(node('l4'));
    tree.addEdge(edge('e-start-short', 'start', 'short'));
    tree.addEdge(edge('e-start-l1', 'start', 'l1'));
    tree.addEdge(edge('e-short-end', 'short', 'end'));
    tree.addEdge(edge('e-l1-l2', 'l1', 'l2'));
    tree.addEdge(edge('e-l2-l3', 'l2', 'l3'));
    tree.addEdge(edge('e-l3-l4', 'l3', 'l4'));
    tree.addEdge(edge('e-l4-end', 'l4', 'end'));

    // Record only long-path sessions first, then short-path to establish shortest=3
    for (let i = 0; i < 5; i++) {
      recordSession(
        tracker,
        ['start', 'l1', 'l2', 'l3', 'l4', 'end'],
        'success',
      );
    }
    for (let i = 0; i < 5; i++) {
      recordSession(tracker, ['start', 'short', 'end'], 'success');
    }

    const engine = new RecommendationEngine(tree, tracker);
    const rec = engine.getEdgeRecommendation('start');

    // The short edge should win
    expect(rec!.recommendedEdgeId).toBe('e-start-short');

    // Get the alternative (long path) and verify its confidence is lower
    const longAlt = rec!.alternativeEdges.find(
      (a) => a.edgeId === 'e-start-l1',
    );
    expect(longAlt).toBeDefined();
    expect(longAlt!.confidence).toBeLessThan(rec!.confidence);
  });

  it('handles case with no successful sessions gracefully', () => {
    tree.addNode(node('start'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'end'));

    recordSession(tracker, ['start', 'end'], 'failure');
    recordSession(tracker, ['start', 'end'], 'failure');

    const engine = new RecommendationEngine(tree, tracker);
    const rec = engine.getEdgeRecommendation('start');

    expect(rec).not.toBeNull();
    expect(rec!.confidence).toBe(0); // no successes
  });

  it('surfaces shortestSuccessfulPath in analyzeHistory', () => {
    tree.addNode(node('start'));
    tree.addNode(node('a'));
    tree.addNode(node('b'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'a'));
    tree.addEdge(edge('e2', 'a', 'b'));
    tree.addEdge(edge('e3', 'b', 'end'));
    tree.addEdge(edge('e4', 'a', 'end'));

    recordSession(tracker, ['start', 'a', 'b', 'end'], 'success'); // 4 nodes
    recordSession(tracker, ['start', 'a', 'end'], 'success'); // 3 nodes ← shortest
    recordSession(tracker, ['start', 'a', 'b', 'end'], 'failure');

    const engine = new RecommendationEngine(tree, tracker);
    const analysis = engine.analyzeHistory();

    expect(analysis.shortestSuccessfulPath).toEqual(['start', 'a', 'end']);
  });

  it('shortestSuccessfulPath is empty when no successful sessions', () => {
    tree.addNode(node('start'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e', 'start', 'end'));

    recordSession(tracker, ['start', 'end'], 'failure');

    const engine = new RecommendationEngine(tree, tracker);
    expect(engine.analyzeHistory().shortestSuccessfulPath).toEqual([]);
  });
});

describe('RecommendationEngine — family-pooled sessions', () => {
  it('pooledSessions contribute to edge recommendations', () => {
    // Tree: start → [A | B]
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('B'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-B', 'start', 'B'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-B-end', 'B', 'end'));

    // No sessions on the tracker itself (brand new tree)
    const engine = new RecommendationEngine(tree, tracker);

    // But pooled sessions from a sibling strongly favor path A
    const siblingRecords = Array.from({ length: 10 }, () => [
      {
        nodeId: 'start',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
      {
        nodeId: 'A',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
      {
        nodeId: 'end',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
    ]);
    engine.pooledSessions = siblingRecords;

    const rec = engine.getEdgeRecommendation('start');
    expect(rec).not.toBeNull();
    expect(rec!.recommendedEdgeId).toBe('e-start-A');
    expect(rec!.confidence).toBeGreaterThan(0);
  });

  it('own sessions and pooled sessions are both considered', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('B'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-B', 'start', 'B'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-B-end', 'B', 'end'));

    // Own sessions favor B
    for (let i = 0; i < 10; i++) {
      recordSession(tracker, ['start', 'B', 'end'], 'success');
    }

    const engine = new RecommendationEngine(tree, tracker);
    const analysis = engine.analyzeHistory();
    expect(analysis.totalSessions).toBe(10);

    // Pooled sessions also exist (favor A) — total should be combined
    engine.pooledSessions = Array.from({ length: 5 }, () => [
      {
        nodeId: 'start',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
      {
        nodeId: 'A',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
      {
        nodeId: 'end',
        timestamp: Date.now(),
        metadata: {},
        status: 'success' as const,
      },
    ]);

    const combined = engine.analyzeHistory();
    expect(combined.totalSessions).toBe(15); // 10 own + 5 pooled
  });

  it('pooledSessions defaults to empty — no effect when unset', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();
    tree.addNode(node('start'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'end'));

    recordSession(tracker, ['start', 'end'], 'success');

    const engine = new RecommendationEngine(tree, tracker);
    expect(engine.pooledSessions).toEqual([]);
    expect(engine.analyzeHistory().totalSessions).toBe(1);
  });
});

describe('RecommendationEngine — confidence decay', () => {
  const DAY_MS = 1000 * 60 * 60 * 24;

  function makeSession(
    nodeIds: string[],
    finalStatus: 'success' | 'failure',
    ageInDays: number,
  ): import('../core/interfaces.js').EnhancedPathRecord[] {
    const baseTimestamp = Date.now() - ageInDays * DAY_MS;
    return nodeIds.map((nodeId, i) => ({
      nodeId,
      timestamp: baseTimestamp + i,
      metadata: {},
      status:
        i === nodeIds.length - 1
          ? finalStatus
          : ('success' as const),
    }));
  }

  it('recent sessions outweigh older sessions with same success rate', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('B'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-B', 'start', 'B'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-B-end', 'B', 'end'));

    // 10 old sessions (90 days ago) favoring path A
    // 5 recent sessions (1 day ago) favoring path B
    const engine = new RecommendationEngine(tree, tracker, {
      decayHalfLifeDays: 30,
    });

    engine.pooledSessions = [
      ...Array.from({ length: 10 }, () =>
        makeSession(['start', 'A', 'end'], 'success', 90),
      ),
      ...Array.from({ length: 5 }, () =>
        makeSession(['start', 'B', 'end'], 'success', 1),
      ),
    ];

    const rec = engine.getEdgeRecommendation('start');
    expect(rec).not.toBeNull();
    // B should win despite fewer sessions — recency matters
    expect(rec!.recommendedEdgeId).toBe('e-start-B');
  });

  it('decay disabled when halfLife is 0 — all sessions equal', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('B'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-B', 'start', 'B'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-B-end', 'B', 'end'));

    const engine = new RecommendationEngine(tree, tracker, {
      decayHalfLifeDays: 0,
    });

    engine.pooledSessions = [
      ...Array.from({ length: 10 }, () =>
        makeSession(['start', 'A', 'end'], 'success', 90),
      ),
      ...Array.from({ length: 5 }, () =>
        makeSession(['start', 'B', 'end'], 'success', 1),
      ),
    ];

    const rec = engine.getEdgeRecommendation('start');
    expect(rec).not.toBeNull();
    // A should win — more raw sessions, no decay
    expect(rec!.recommendedEdgeId).toBe('e-start-A');
  });

  it('sessions at exactly halfLife age get ~50% weight', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('A'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'A'));
    tree.addEdge(edge('e2', 'A', 'end'));

    const engine = new RecommendationEngine(tree, tracker, {
      decayHalfLifeDays: 30,
    });

    // Access the private method via any for testing
    const session = makeSession(['start', 'A', 'end'], 'success', 30);
    const weight = (engine as any).sessionAgeWeight(session);
    expect(weight).toBeCloseTo(0.5, 1);
  });

  it('very old sessions have near-zero weight', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'end'));

    const engine = new RecommendationEngine(tree, tracker, {
      decayHalfLifeDays: 30,
    });

    const session = makeSession(['start', 'end'], 'success', 365);
    const weight = (engine as any).sessionAgeWeight(session);
    // 365/30 ≈ 12 half-lives → weight ≈ 2^(-12) �� 0.0002
    expect(weight).toBeLessThan(0.001);
  });

  it('brand-new sessions get weight 1.0', () => {
    const tree = new DecisionTree();
    const tracker = new PathTracker();

    tree.addNode(node('start'));
    tree.addNode(node('end'));
    tree.addEdge(edge('e1', 'start', 'end'));

    const engine = new RecommendationEngine(tree, tracker, {
      decayHalfLifeDays: 30,
    });

    const session = makeSession(['start', 'end'], 'success', 0);
    const weight = (engine as any).sessionAgeWeight(session);
    expect(weight).toBeCloseTo(1.0, 2);
  });
});
