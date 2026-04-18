import type {
  EnhancedPathRecord,
  IDecisionTree,
  IEnhancedPathTracker,
  NodeId,
} from '../core/interfaces.js';

export interface PathAnalysis {
  totalSessions: number;
  successRate: number;
  averagePathLength: number;
  mostCommonPath: NodeId[];
  mostSuccessfulPath: NodeId[];
  /** Shortest successful path by node count. Empty if no successful sessions. */
  shortestSuccessfulPath: NodeId[];
  bottleneckNodes: NodeId[];
}

export interface NodeStats {
  nodeId: NodeId;
  visitCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageDuration: number;
}

export interface EdgeRecommendation {
  fromNodeId: NodeId;
  recommendedEdgeId: string;
  targetNodeId: NodeId;
  confidence: number;
  reasoning: string;
  alternativeEdges: Array<{
    edgeId: string;
    targetNodeId: NodeId;
    confidence: number;
  }>;
}

export class RecommendationEngine {
  /**
   * Extra sessions (e.g. from family-sibling trees) to merge with the
   * tracker's own sessions when computing recommendations.
   */
  pooledSessions: EnhancedPathRecord[][] = [];

  constructor(
    private tree: IDecisionTree,
    private tracker: IEnhancedPathTracker,
  ) {}

  /** All sessions: tracker-owned + pooled from family siblings. */
  private getAllSessions(): EnhancedPathRecord[][] {
    const own = this.tracker.getAllSessions();
    if (this.pooledSessions.length === 0) return own;
    return [...own, ...this.pooledSessions];
  }

  analyzeHistory(): PathAnalysis {
    const sessions = this.getAllSessions();
    const totalSessions = sessions.length;

    if (totalSessions === 0) {
      return {
        totalSessions: 0,
        successRate: 0,
        averagePathLength: 0,
        mostCommonPath: [],
        mostSuccessfulPath: [],
        shortestSuccessfulPath: [],
        bottleneckNodes: [],
      };
    }

    // Compute overall success rate across all records in all sessions
    let totalRecords = 0;
    let totalSuccesses = 0;
    let totalPathLength = 0;

    const pathCounts = new Map<string, number>();
    const pathSuccessRates = new Map<
      string,
      { successes: number; total: number }
    >();

    for (const session of sessions) {
      const pathKey = session.map((r) => r.nodeId).join('->');
      const nodeIds = session.map((r) => r.nodeId);
      totalPathLength += nodeIds.length;

      pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);

      let sessionSuccesses = 0;
      let sessionTotal = 0;
      for (const record of session) {
        totalRecords++;
        if (record.status === 'success') {
          totalSuccesses++;
          sessionSuccesses++;
        }
        sessionTotal++;
      }

      const existing = pathSuccessRates.get(pathKey);
      if (existing) {
        existing.successes += sessionSuccesses;
        existing.total += sessionTotal;
      } else {
        pathSuccessRates.set(pathKey, {
          successes: sessionSuccesses,
          total: sessionTotal,
        });
      }
    }

    const successRate = totalRecords > 0 ? totalSuccesses / totalRecords : 0;
    const averagePathLength = totalPathLength / totalSessions;

    // Most common path
    let mostCommonPathKey = '';
    let mostCommonCount = 0;
    for (const [key, count] of pathCounts) {
      if (count > mostCommonCount) {
        mostCommonCount = count;
        mostCommonPathKey = key;
      }
    }
    const mostCommonPath = mostCommonPathKey
      ? mostCommonPathKey.split('->')
      : [];

    // Most successful path
    let mostSuccessfulPathKey = '';
    let highestSuccessRate = -1;
    for (const [key, stats] of pathSuccessRates) {
      const rate = stats.total > 0 ? stats.successes / stats.total : 0;
      if (rate > highestSuccessRate) {
        highestSuccessRate = rate;
        mostSuccessfulPathKey = key;
      }
    }
    const mostSuccessfulPath = mostSuccessfulPathKey
      ? mostSuccessfulPathKey.split('->')
      : [];

    // Shortest successful path (by final-record status)
    let shortestSuccessfulPath: NodeId[] = [];
    let shortestLen = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      const last = session[session.length - 1];
      const succeeded = last?.status === 'success';
      if (succeeded && session.length < shortestLen) {
        shortestLen = session.length;
        shortestSuccessfulPath = session.map((r) => r.nodeId);
      }
    }

    // Bottleneck nodes
    const bottlenecks = this.identifyBottlenecks();
    const bottleneckNodes = bottlenecks.map((b) => b.nodeId);

    return {
      totalSessions,
      successRate,
      averagePathLength,
      mostCommonPath,
      mostSuccessfulPath,
      shortestSuccessfulPath,
      bottleneckNodes,
    };
  }

  getNodeStats(nodeId: NodeId): NodeStats {
    const sessions = this.getAllSessions();
    let visitCount = 0;
    let successCount = 0;
    let failureCount = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const session of sessions) {
      for (const record of session) {
        if (record.nodeId === nodeId) {
          visitCount++;
          if (record.status === 'success') {
            successCount++;
          } else if (record.status === 'failure') {
            failureCount++;
          }
          if (record.duration !== undefined) {
            totalDuration += record.duration;
            durationCount++;
          }
        }
      }
    }

    return {
      nodeId,
      visitCount,
      successCount,
      failureCount,
      successRate: visitCount > 0 ? successCount / visitCount : 0,
      averageDuration: durationCount > 0 ? totalDuration / durationCount : 0,
    };
  }

  getEdgeRecommendation(fromNodeId: NodeId): EdgeRecommendation | null {
    const outgoingEdges = this.tree.getOutgoingEdges(fromNodeId);
    if (outgoingEdges.length === 0) {
      return null;
    }

    const sessions = this.getAllSessions();

    // For each outgoing edge target, track how often sessions that went through
    // that target were successful, and the lengths of those successful sessions
    const edgeOutcomes = new Map<
      string,
      {
        edgeId: string;
        targetNodeId: NodeId;
        successes: number;
        total: number;
        successfulLengths: number[];
      }
    >();

    for (const edge of outgoingEdges) {
      edgeOutcomes.set(edge.id, {
        edgeId: edge.id,
        targetNodeId: edge.targetId,
        successes: 0,
        total: 0,
        successfulLengths: [],
      });
    }

    // Also track the shortest successful session length overall (for efficiency weighting)
    let shortestSuccessLength = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      const last = session[session.length - 1];
      const sessionSucceeded = last?.status === 'success';
      if (sessionSucceeded && session.length < shortestSuccessLength) {
        shortestSuccessLength = session.length;
      }
    }

    for (const session of sessions) {
      for (let i = 0; i < session.length - 1; i++) {
        const record = session[i] as EnhancedPathRecord;
        const nextRecord = session[i + 1] as EnhancedPathRecord;

        if (record.nodeId === fromNodeId) {
          // Find which edge was taken based on the next node
          for (const edge of outgoingEdges) {
            if (edge.targetId === nextRecord.nodeId) {
              const outcomes = edgeOutcomes.get(edge.id);
              if (outcomes) {
                outcomes.total++;
                // Check if the rest of the session from this point was successful
                const remainingRecords = session.slice(i + 1);
                const allSuccessful = remainingRecords.every(
                  (r) => r.status === 'success' || r.status === 'pending',
                );
                if (allSuccessful) {
                  outcomes.successes++;
                  outcomes.successfulLengths.push(session.length);
                }
              }
              break;
            }
          }
        }
      }
    }

    // Compute composite confidence for each edge: success_rate × sample_factor × efficiency_factor
    // Efficiency factor rewards edges whose successful sessions are short relative to the
    // shortest successful session seen for this tree.
    const computeConfidence = (outcomes: {
      successes: number;
      total: number;
      successfulLengths: number[];
    }): number => {
      const rate = outcomes.total > 0 ? outcomes.successes / outcomes.total : 0;
      const sampleFactor = Math.min(outcomes.total / 10, 1);

      let efficiencyFactor = 1;
      if (
        outcomes.successfulLengths.length > 0 &&
        shortestSuccessLength !== Number.POSITIVE_INFINITY
      ) {
        const avgLen =
          outcomes.successfulLengths.reduce((a, b) => a + b, 0) /
          outcomes.successfulLengths.length;
        efficiencyFactor = shortestSuccessLength / avgLen;
      }

      return rate * sampleFactor * efficiencyFactor;
    };

    // Find the best edge (highest composite confidence, with sample count as tiebreaker)
    let bestEdge:
      | {
          edgeId: string;
          targetNodeId: NodeId;
          successes: number;
          total: number;
          successfulLengths: number[];
        }
      | undefined;
    let bestConfidence = -1;
    let bestRate = -1;

    const allEdgeResults: Array<{
      edgeId: string;
      targetNodeId: NodeId;
      confidence: number;
    }> = [];

    for (const outcomes of edgeOutcomes.values()) {
      const conf = computeConfidence(outcomes);
      const rate = outcomes.total > 0 ? outcomes.successes / outcomes.total : 0;
      allEdgeResults.push({
        edgeId: outcomes.edgeId,
        targetNodeId: outcomes.targetNodeId,
        confidence: conf,
      });
      if (
        conf > bestConfidence ||
        (conf === bestConfidence && outcomes.total > (bestEdge?.total ?? 0))
      ) {
        bestConfidence = conf;
        bestRate = rate;
        bestEdge = outcomes;
      }
    }

    if (!bestEdge) {
      return null;
    }

    const confidence = bestConfidence < 0 ? 0 : bestConfidence;

    const alternativeEdges = allEdgeResults
      .filter((e) => e.edgeId !== bestEdge?.edgeId)
      .sort((a, b) => b.confidence - a.confidence);

    const totalSamples = bestEdge.total;
    const avgLen =
      bestEdge.successfulLengths.length > 0
        ? bestEdge.successfulLengths.reduce((a, b) => a + b, 0) /
          bestEdge.successfulLengths.length
        : 0;
    const reasoning =
      totalSamples > 0
        ? `Edge "${bestEdge.edgeId}" succeeded in ${bestEdge.successes}/${totalSamples} sessions (${(bestRate * 100).toFixed(1)}% rate, avg path length ${avgLen.toFixed(1)}, shortest known ${shortestSuccessLength === Number.POSITIVE_INFINITY ? 'n/a' : shortestSuccessLength}).`
        : `No historical data available for edges from node "${fromNodeId}". Recommendation is based on default ordering.`;

    return {
      fromNodeId,
      recommendedEdgeId: bestEdge.edgeId,
      targetNodeId: bestEdge.targetNodeId,
      confidence,
      reasoning,
      alternativeEdges,
    };
  }

  identifyBottlenecks(failureThreshold: number = 0.5): NodeStats[] {
    const sessions = this.getAllSessions();
    const nodeIds = new Set<NodeId>();

    for (const session of sessions) {
      for (const record of session) {
        nodeIds.add(record.nodeId);
      }
    }

    const bottlenecks: NodeStats[] = [];
    for (const nodeId of nodeIds) {
      const stats = this.getNodeStats(nodeId);
      if (
        stats.visitCount > 0 &&
        stats.failureCount / stats.visitCount >= failureThreshold
      ) {
        bottlenecks.push(stats);
      }
    }

    return bottlenecks.sort((a, b) => {
      const aFailureRate = a.visitCount > 0 ? a.failureCount / a.visitCount : 0;
      const bFailureRate = b.visitCount > 0 ? b.failureCount / b.visitCount : 0;
      return bFailureRate - aFailureRate;
    });
  }

  generateOptimizationReport(): {
    analysis: PathAnalysis;
    bottlenecks: NodeStats[];
    edgeRecommendations: Map<NodeId, EdgeRecommendation>;
  } {
    const analysis = this.analyzeHistory();
    const bottlenecks = this.identifyBottlenecks();

    const edgeRecommendations = new Map<NodeId, EdgeRecommendation>();

    // Generate edge recommendations for all nodes that have outgoing edges
    const sessions = this.getAllSessions();
    const visitedNodes = new Set<NodeId>();
    for (const session of sessions) {
      for (const record of session) {
        visitedNodes.add(record.nodeId);
      }
    }

    for (const nodeId of visitedNodes) {
      const recommendation = this.getEdgeRecommendation(nodeId);
      if (recommendation) {
        edgeRecommendations.set(nodeId, recommendation);
      }
    }

    return {
      analysis,
      bottlenecks,
      edgeRecommendations,
    };
  }
}
