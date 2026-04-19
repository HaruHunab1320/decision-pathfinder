import type {
  EnhancedPathRecord,
  IDecisionTree,
  IEnhancedPathTracker,
  NodeId,
} from '../core/interfaces.js';

/** A proposed structural edit to the tree, derived from session analysis. */
export interface TreeEditSuggestion {
  type: 'remove_node' | 'shortcut_edge' | 'flag_bottleneck' | 'reorder_edges';
  nodeId?: NodeId;
  fromNodeId?: NodeId;
  toNodeId?: NodeId;
  confidence: number;
  reasoning: string;
  evidence: {
    totalSessions: number;
    relevantSessions: number;
    metric: number; // the key stat backing this suggestion
  };
}

/**
 * Analyzes session history to propose tree structural improvements.
 *
 * Looks for patterns like:
 * - Nodes that successful sessions consistently skip
 * - Shortcuts: when sessions always follow A → B → C, suggest A → C
 * - Bottlenecks: nodes with high failure rates
 * - Edge reordering: when the "wrong" edge is tried first most of the time
 */
export class TreeEvolution {
  private pooledSessions: EnhancedPathRecord[][] = [];

  constructor(
    private tree: IDecisionTree,
    private tracker: IEnhancedPathTracker,
  ) {}

  setPooledSessions(sessions: EnhancedPathRecord[][]): void {
    this.pooledSessions = sessions;
  }

  private getAllSessions(): EnhancedPathRecord[][] {
    const own = this.tracker.getAllSessions();
    return this.pooledSessions.length > 0
      ? [...own, ...this.pooledSessions]
      : own;
  }

  /** Generate all edit suggestions, sorted by confidence. */
  analyze(): TreeEditSuggestion[] {
    const suggestions: TreeEditSuggestion[] = [
      ...this.findSkippableNodes(),
      ...this.findShortcuts(),
      ...this.findBottlenecks(),
      ...this.findEdgeReordering(),
    ];
    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Find nodes that successful sessions consistently skip.
   * "80% of successful sessions don't visit node X → suggest removing it."
   */
  private findSkippableNodes(): TreeEditSuggestion[] {
    const sessions = this.getAllSessions();
    if (sessions.length < 5) return []; // need enough data

    const successfulSessions = sessions.filter((s) => {
      const last = s[s.length - 1];
      return last?.status === 'success';
    });
    if (successfulSessions.length < 3) return [];

    // Count how often each node appears in successful sessions
    const nodeVisitCount = new Map<NodeId, number>();
    for (const session of successfulSessions) {
      const visited = new Set(session.map((r) => r.nodeId));
      for (const nodeId of visited) {
        nodeVisitCount.set(nodeId, (nodeVisitCount.get(nodeId) ?? 0) + 1);
      }
    }

    const suggestions: TreeEditSuggestion[] = [];
    // Check all non-terminal, non-root nodes
    const allNodes = new Set<NodeId>();
    for (const session of sessions) {
      for (const r of session) allNodes.add(r.nodeId);
    }

    for (const nodeId of allNodes) {
      const node = this.tree.getNode(nodeId);
      if (!node) continue;
      if (node.type === 'success' || node.type === 'failure') continue;

      const incoming = this.tree.getIncomingEdges(nodeId);
      if (incoming.length === 0) continue; // root node — don't suggest removal

      const visitRate =
        (nodeVisitCount.get(nodeId) ?? 0) / successfulSessions.length;
      const skipRate = 1 - visitRate;

      if (skipRate >= 0.8 && successfulSessions.length >= 5) {
        suggestions.push({
          type: 'remove_node',
          nodeId,
          confidence: skipRate,
          reasoning: `${(skipRate * 100).toFixed(0)}% of successful sessions skip node "${node.label}" — it may be unnecessary.`,
          evidence: {
            totalSessions: sessions.length,
            relevantSessions: successfulSessions.length,
            metric: skipRate,
          },
        });
      }
    }

    return suggestions;
  }

  /**
   * Find shortcuts: when sessions consistently go A → B → C with B being
   * a pass-through, suggest adding a direct A → C edge.
   */
  private findShortcuts(): TreeEditSuggestion[] {
    const sessions = this.getAllSessions();
    if (sessions.length < 5) return [];

    const successfulSessions = sessions.filter((s) => {
      const last = s[s.length - 1];
      return last?.status === 'success';
    });
    if (successfulSessions.length < 3) return [];

    // Count consecutive pairs A→B→C
    const tripleCount = new Map<string, number>();
    for (const session of successfulSessions) {
      for (let i = 0; i < session.length - 2; i++) {
        const key = `${session[i]!.nodeId}|${session[i + 1]!.nodeId}|${session[i + 2]!.nodeId}`;
        tripleCount.set(key, (tripleCount.get(key) ?? 0) + 1);
      }
    }

    const suggestions: TreeEditSuggestion[] = [];
    for (const [key, count] of tripleCount) {
      const [a, b, c] = key.split('|') as [string, string, string];
      const rate = count / successfulSessions.length;

      // Check if B is always just a pass-through (single outgoing edge used)
      const bOutgoing = this.tree.getOutgoingEdges(b);
      if (bOutgoing.length <= 1) continue; // already linear, no shortcut needed

      // Check if direct edge A→C already exists
      const aOutgoing = this.tree.getOutgoingEdges(a);
      if (aOutgoing.some((e) => e.targetId === c)) continue;

      if (rate >= 0.7) {
        const bNode = this.tree.getNode(b);
        suggestions.push({
          type: 'shortcut_edge',
          fromNodeId: a,
          toNodeId: c,
          nodeId: b,
          confidence: rate,
          reasoning: `${(rate * 100).toFixed(0)}% of successful sessions go ${a} → ${bNode?.label ?? b} → ${c}. Consider adding a direct edge to skip "${bNode?.label ?? b}".`,
          evidence: {
            totalSessions: sessions.length,
            relevantSessions: successfulSessions.length,
            metric: rate,
          },
        });
      }
    }

    return suggestions;
  }

  /**
   * Find bottleneck nodes with high failure rates.
   */
  private findBottlenecks(): TreeEditSuggestion[] {
    const sessions = this.getAllSessions();
    if (sessions.length < 3) return [];

    const nodeStats = new Map<
      NodeId,
      { visits: number; failures: number }
    >();

    for (const session of sessions) {
      for (const record of session) {
        const stats = nodeStats.get(record.nodeId) ?? {
          visits: 0,
          failures: 0,
        };
        stats.visits++;
        if (record.status === 'failure') stats.failures++;
        nodeStats.set(record.nodeId, stats);
      }
    }

    const suggestions: TreeEditSuggestion[] = [];
    for (const [nodeId, stats] of nodeStats) {
      if (stats.visits < 3) continue;
      const failureRate = stats.failures / stats.visits;
      if (failureRate >= 0.5) {
        const node = this.tree.getNode(nodeId);
        suggestions.push({
          type: 'flag_bottleneck',
          nodeId,
          confidence: failureRate,
          reasoning: `Node "${node?.label ?? nodeId}" fails ${(failureRate * 100).toFixed(0)}% of the time (${stats.failures}/${stats.visits} visits). Consider adding error handling or an alternative path.`,
          evidence: {
            totalSessions: sessions.length,
            relevantSessions: stats.visits,
            metric: failureRate,
          },
        });
      }
    }

    return suggestions;
  }

  /**
   * Find edges that should be reordered — when the first-tried edge
   * consistently fails and a later edge succeeds.
   */
  private findEdgeReordering(): TreeEditSuggestion[] {
    const sessions = this.getAllSessions();
    if (sessions.length < 5) return [];

    // For each node with multiple outgoing edges, track which edge is taken
    // and whether the session succeeds
    const edgeSuccess = new Map<
      string,
      { edgeId: string; targetId: NodeId; successes: number; total: number }
    >();

    for (const session of sessions) {
      const lastRecord = session[session.length - 1];
      const sessionSucceeded = lastRecord?.status === 'success';

      for (let i = 0; i < session.length - 1; i++) {
        const nodeId = session[i]!.nodeId;
        const nextNodeId = session[i + 1]!.nodeId;
        const outgoing = this.tree.getOutgoingEdges(nodeId);
        if (outgoing.length <= 1) continue;

        const edge = outgoing.find((e) => e.targetId === nextNodeId);
        if (!edge) continue;

        const key = `${nodeId}:${edge.id}`;
        const stats = edgeSuccess.get(key) ?? {
          edgeId: edge.id,
          targetId: edge.targetId,
          successes: 0,
          total: 0,
        };
        stats.total++;
        if (sessionSucceeded) stats.successes++;
        edgeSuccess.set(key, stats);
      }
    }

    // Group by source node
    const byNode = new Map<NodeId, typeof edgeSuccess extends Map<string, infer V> ? V[] : never>();
    for (const [key, stats] of edgeSuccess) {
      const nodeId = key.split(':')[0]!;
      const arr = byNode.get(nodeId) ?? [];
      arr.push(stats);
      byNode.set(nodeId, arr);
    }

    const suggestions: TreeEditSuggestion[] = [];
    for (const [nodeId, edges] of byNode) {
      if (edges.length < 2) continue;
      edges.sort((a, b) => {
        const rateA = a.total > 0 ? a.successes / a.total : 0;
        const rateB = b.total > 0 ? b.successes / b.total : 0;
        return rateB - rateA;
      });

      const best = edges[0]!;
      const bestRate = best.total > 0 ? best.successes / best.total : 0;
      const worst = edges[edges.length - 1]!;
      const worstRate = worst.total > 0 ? worst.successes / worst.total : 0;

      // Only suggest reordering if there's a meaningful gap
      if (bestRate - worstRate >= 0.3 && best.total >= 3) {
        const node = this.tree.getNode(nodeId);
        suggestions.push({
          type: 'reorder_edges',
          nodeId,
          confidence: bestRate - worstRate,
          reasoning: `At "${node?.label ?? nodeId}", edge "${best.edgeId}" succeeds ${(bestRate * 100).toFixed(0)}% vs "${worst.edgeId}" at ${(worstRate * 100).toFixed(0)}%. Consider reordering edges so the better path is tried first.`,
          evidence: {
            totalSessions: sessions.length,
            relevantSessions: best.total + worst.total,
            metric: bestRate - worstRate,
          },
        });
      }
    }

    return suggestions;
  }
}
