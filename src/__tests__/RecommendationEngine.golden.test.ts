import { describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type {
  EnhancedPathRecord,
  IEdge,
  IEnhancedPathTracker,
  INode,
} from '../core/interfaces.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';

/**
 * GOLDEN / ACCEPTANCE TEST for the confidence-kernel migration.
 *
 * This reimplements decision-pathfinder's ORIGINAL per-edge confidence formula
 * inline (exactly as it existed in RecommendationEngine before delegating to
 * `@_89/confidence-kernel`) and asserts the live engine — which now routes the
 * composite + decay through the kernel — reproduces it to ~12 decimal places.
 *
 * Original formula (per edge, per `getEdgeRecommendation`):
 *   decay(session)  = exp(-max(ageDays,0) * ln2 / halfLife)     (halfLife 30)
 *   weightedTotal   = Σ decay over edge-traversal occurrences
 *   weightedSucc    = Σ decay over occurrences whose remainder succeeded
 *   rate            = weightedSucc / weightedTotal   (0 when total 0)
 *   sample          = min(weightedTotal / 10, 1)
 *   efficiency      = GLOBAL shortest successful session length / this edge's
 *                     average successful session length   (1 when N/A)
 *   confidence      = rate * sample * efficiency
 *
 * The efficiency numerator (shortest) is GLOBAL across the whole tree's
 * sessions, which is why the kernel's default step-based efficiencyFactor
 * cannot reproduce it — the host computes the number and passes it through.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

function node(id: string): INode {
  return { id, type: 'test', label: id, metadata: {} };
}
function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}

/** Build a session of records with a fixed age (days) and a final status. */
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

/**
 * A tracker that just returns the sessions it was handed. Only getAllSessions
 * is exercised by getEdgeRecommendation, so the rest are inert stubs.
 */
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

/**
 * Independent reimplementation of the ORIGINAL formula for a single node's
 * outgoing edges. Returns the confidence per edge id, using `now` for decay.
 */
function referenceConfidences(
  sessions: EnhancedPathRecord[][],
  fromNodeId: string,
  outgoing: IEdge[],
  halfLife: number,
  now: number,
): Map<string, number> {
  const decay = (s: EnhancedPathRecord[]): number => {
    if (halfLife <= 0 || !Number.isFinite(halfLife)) return 1;
    const first = s[0];
    if (!first) return 1;
    const ageDays = (now - first.timestamp) / DAY_MS;
    if (ageDays <= 0) return 1;
    return Math.exp((-ageDays * Math.LN2) / halfLife);
  };

  // Global shortest successful session length.
  let shortest = Number.POSITIVE_INFINITY;
  for (const s of sessions) {
    const last = s[s.length - 1];
    if (last?.status === 'success' && s.length < shortest) shortest = s.length;
  }

  const acc = new Map<
    string,
    { succ: number; total: number; lens: number[] }
  >();
  for (const e of outgoing) acc.set(e.id, { succ: 0, total: 0, lens: [] });

  for (const s of sessions) {
    const w = decay(s);
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i]!.nodeId !== fromNodeId) continue;
      const next = s[i + 1]!;
      for (const e of outgoing) {
        if (e.targetId === next.nodeId) {
          const a = acc.get(e.id)!;
          a.total += w;
          const remaining = s.slice(i + 1);
          const ok = remaining.every(
            (r) => r.status === 'success' || r.status === 'pending',
          );
          if (ok) {
            a.succ += w;
            a.lens.push(s.length);
          }
          break;
        }
      }
    }
  }

  const out = new Map<string, number>();
  for (const [id, a] of acc) {
    const rate = a.total > 0 ? a.succ / a.total : 0;
    const sample = Math.min(a.total / 10, 1);
    let eff = 1;
    if (a.lens.length > 0 && shortest !== Number.POSITIVE_INFINITY) {
      const avg = a.lens.reduce((x, y) => x + y, 0) / a.lens.length;
      eff = shortest / avg;
    }
    out.set(id, rate * sample * eff);
  }
  return out;
}

describe('GOLDEN: RecommendationEngine confidence == original inline formula', () => {
  function buildTree(): { tree: DecisionTree; outgoing: IEdge[] } {
    // start → [short (start→A→end) | long (start→l1→l2→l3→l4→end)]
    const tree = new DecisionTree();
    for (const id of ['start', 'A', 'end', 'l1', 'l2', 'l3', 'l4']) {
      tree.addNode(node(id));
    }
    tree.addEdge(edge('e-start-A', 'start', 'A'));
    tree.addEdge(edge('e-start-l1', 'start', 'l1'));
    tree.addEdge(edge('e-A-end', 'A', 'end'));
    tree.addEdge(edge('e-l1-l2', 'l1', 'l2'));
    tree.addEdge(edge('e-l2-l3', 'l2', 'l3'));
    tree.addEdge(edge('e-l3-l4', 'l3', 'l4'));
    tree.addEdge(edge('e-l4-end', 'l4', 'end'));
    return { tree, outgoing: tree.getOutgoingEdges('start') };
  }

  it('matches to 12 decimals across mixed ages, outcomes, and lengths', () => {
    const sessions: EnhancedPathRecord[][] = [
      session(['start', 'A', 'end'], 'success', 2),
      session(['start', 'A', 'end'], 'success', 5),
      session(['start', 'A', 'end'], 'failure', 1),
      session(['start', 'A', 'end'], 'success', 40),
      session(['start', 'l1', 'l2', 'l3', 'l4', 'end'], 'success', 3),
      session(['start', 'l1', 'l2', 'l3', 'l4', 'end'], 'success', 60),
      session(['start', 'l1', 'l2', 'l3', 'l4', 'end'], 'failure', 10),
    ];

    const { tree, outgoing } = buildTree();
    const now = Date.now();
    const expected = referenceConfidences(sessions, 'start', outgoing, 30, now);

    const engine = new RecommendationEngine(tree, fakeTracker(sessions), {
      decayHalfLifeDays: 30,
    });
    const rec = engine.getEdgeRecommendation('start', now)!;
    expect(rec).not.toBeNull();

    // Best edge confidence.
    expect(rec.confidence).toBeCloseTo(
      expected.get(rec.recommendedEdgeId)!,
      12,
    );
    // Every alternative edge confidence.
    for (const alt of rec.alternativeEdges) {
      expect(alt.confidence).toBeCloseTo(expected.get(alt.edgeId)!, 12);
    }
  });

  it("saturates to full confidence with 10 recent clean successes (would trigger DP's >=0.6 override)", () => {
    // 10 identical shortest-path successes → rate 1, sample 1, eff 1 → 1.0
    const sessions: EnhancedPathRecord[][] = Array.from({ length: 10 }, () =>
      session(['start', 'A', 'end'], 'success', 0),
    );
    const { tree } = buildTree();
    const engine = new RecommendationEngine(tree, fakeTracker(sessions), {
      decayHalfLifeDays: 30,
    });
    const rec = engine.getEdgeRecommendation('start')!;
    expect(rec.confidence).toBeCloseTo(1, 12);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('decay-disabled (halfLife 0) matches the reference with weight 1 everywhere', () => {
    const sessions: EnhancedPathRecord[][] = [
      session(['start', 'A', 'end'], 'success', 90),
      session(['start', 'A', 'end'], 'success', 1),
      session(['start', 'l1', 'l2', 'l3', 'l4', 'end'], 'success', 45),
    ];
    const { tree, outgoing } = buildTree();
    const now = Date.now();
    const expected = referenceConfidences(sessions, 'start', outgoing, 0, now);

    const engine = new RecommendationEngine(tree, fakeTracker(sessions), {
      decayHalfLifeDays: 0,
    });
    const rec = engine.getEdgeRecommendation('start', now)!;
    expect(rec.confidence).toBeCloseTo(
      expected.get(rec.recommendedEdgeId)!,
      12,
    );
    for (const alt of rec.alternativeEdges) {
      expect(alt.confidence).toBeCloseTo(expected.get(alt.edgeId)!, 12);
    }
  });
});
