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
  constructor(
    private tree: IDecisionTree,
    private tracker: IEnhancedPathTracker,
  ) {}

  analyzeHistory(): PathAnalysis {
    const sessions = this.tracker.getAllSessions();
    const totalSessions = sessions.length;

    if (totalSessions === 0) {
      return {
        totalSessions: 0,
        successRate: 0,
        averagePathLength: 0,
        mostCommonPath: [],
        mostSuccessfulPath: [],
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

    // Bottleneck nodes
    const bottlenecks = this.identifyBottlenecks();
    const bottleneckNodes = bottlenecks.map((b) => b.nodeId);

    return {
      totalSessions,
      successRate,
      averagePathLength,
      mostCommonPath,
      mostSuccessfulPath,
      bottleneckNodes,
    };
  }

  getNodeStats(nodeId: NodeId): NodeStats {
    const sessions = this.tracker.getAllSessions();
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

    const sessions = this.tracker.getAllSessions();

    // For each outgoing edge target, track how often sessions that went through
    // that target were successful
    const edgeOutcomes = new Map<
      string,
      { edgeId: string; targetNodeId: NodeId; successes: number; total: number }
    >();

    for (const edge of outgoingEdges) {
      edgeOutcomes.set(edge.id, {
        edgeId: edge.id,
        targetNodeId: edge.targetId,
        successes: 0,
        total: 0,
      });
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
                }
              }
              break;
            }
          }
        }
      }
    }

    // Find the best edge
    let bestEdge:
      | {
          edgeId: string;
          targetNodeId: NodeId;
          successes: number;
          total: number;
        }
      | undefined;
    let bestRate = -1;

    const allEdgeResults: Array<{
      edgeId: string;
      targetNodeId: NodeId;
      confidence: number;
    }> = [];

    for (const outcomes of edgeOutcomes.values()) {
      const rate = outcomes.total > 0 ? outcomes.successes / outcomes.total : 0;
      allEdgeResults.push({
        edgeId: outcomes.edgeId,
        targetNodeId: outcomes.targetNodeId,
        confidence: rate,
      });
      if (
        rate > bestRate ||
        (rate === bestRate && outcomes.total > (bestEdge?.total ?? 0))
      ) {
        bestRate = rate;
        bestEdge = outcomes;
      }
    }

    if (!bestEdge) {
      return null;
    }

    // Confidence is based on sample size and success rate
    const sampleSizeFactor = Math.min(bestEdge.total / 10, 1); // caps at 10 samples
    const confidence = bestRate * sampleSizeFactor;

    const alternativeEdges = allEdgeResults
      .filter((e) => e.edgeId !== bestEdge?.edgeId)
      .sort((a, b) => b.confidence - a.confidence);

    const totalSamples = bestEdge.total;
    const reasoning =
      totalSamples > 0
        ? `Edge "${bestEdge.edgeId}" led to successful outcomes in ${bestEdge.successes}/${totalSamples} sessions (${(bestRate * 100).toFixed(1)}% success rate).`
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
    const sessions = this.tracker.getAllSessions();
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
    const sessions = this.tracker.getAllSessions();
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
