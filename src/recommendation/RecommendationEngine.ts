import {
  ageDecayWeight,
  detectDrift,
  type HistoryRun,
  scoreHistory,
} from '@_89/confidence-kernel';
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
  /**
   * True when this edge's RECENT success rate has collapsed relative to its
   * lifetime rate (see {@link RecommendationEngineOptions.driftThreshold}).
   * A drifted edge has had its confidence clamped to
   * `driftDemotedCeiling` so it can no longer trigger the high-confidence
   * LLM-skip override. Always reported, even when demotion is disabled.
   */
  drifted: boolean;
  alternativeEdges: Array<{
    edgeId: string;
    targetNodeId: NodeId;
    confidence: number;
    drifted: boolean;
  }>;
}

export interface RecommendationEngineOptions {
  /**
   * Half-life for session age decay in days. Sessions older than this
   * contribute half as much as brand-new sessions. Set to 0 or Infinity
   * to disable decay. Default: 30 days.
   */
  decayHalfLifeDays?: number;
  /**
   * Apply drift demotion (clamp a drifted edge's confidence to
   * {@link driftDemotedCeiling}). Detection always runs and is reported via
   * `EdgeRecommendation.drifted`; this only controls the clamp.
   * Default: true.
   */
  driftDemotion?: boolean;
  /**
   * How many of an edge's most-recent traversals form the "recent" window
   * used for drift detection. Default: 5.
   */
  driftRecentN?: number;
  /**
   * How far an edge's recent success rate may fall below its lifetime rate
   * before it counts as drift. Default: 0.2 (20 percentage points).
   */
  driftThreshold?: number;
  /**
   * Minimum traversals of an edge before drift is evaluated at all — below
   * this, a couple of unlucky runs cannot demote an edge.
   * Default: `driftRecentN`.
   */
  driftMinRuns?: number;
  /**
   * Confidence ceiling applied to a drifted edge. Default: 0.5.
   *
   * Deliberately between the two consumer thresholds: below the 0.6
   * LLM-skip override (so a collapsing edge can never skip the LLM) but above
   * the 0.2 "bias the prompt" tier (so the edge is still offered to the LLM as
   * a hint). Demote, don't erase.
   */
  driftDemotedCeiling?: number;
}

export class RecommendationEngine {
  /**
   * Extra sessions (e.g. from family-sibling trees) to merge with the
   * tracker's own sessions when computing recommendations.
   */
  pooledSessions: EnhancedPathRecord[][] = [];

  private decayHalfLifeDays: number;
  private driftDemotion: boolean;
  private driftRecentN: number;
  private driftThreshold: number;
  private driftMinRuns: number;
  private driftDemotedCeiling: number;

  constructor(
    private tree: IDecisionTree,
    private tracker: IEnhancedPathTracker,
    options?: RecommendationEngineOptions,
  ) {
    this.decayHalfLifeDays = options?.decayHalfLifeDays ?? 30;
    this.driftDemotion = options?.driftDemotion ?? true;
    this.driftRecentN = options?.driftRecentN ?? 5;
    this.driftThreshold = options?.driftThreshold ?? 0.2;
    this.driftMinRuns = options?.driftMinRuns ?? this.driftRecentN;
    this.driftDemotedCeiling = options?.driftDemotedCeiling ?? 0.5;
  }

  /**
   * Compute age-based weight for a session. Uses exponential decay:
   * weight = exp(-days_old * ln(2) / halfLife)
   *
   * A session exactly halfLife days old gets weight 0.5.
   * A brand-new session gets weight 1.0.
   * Disabled (weight always 1.0) when halfLife is 0 or Infinity.
   *
   * Delegates the decay math to the shared confidence-kernel
   * (`ageDecayWeight(ageDays, halfLife, 'e')`), which is byte-for-byte
   * identical to the former inline `exp(-ageDays·ln2/halfLife)` — including
   * the age-clamp at 0 (a brand-new or future-dated session gets weight 1.0)
   * and the disabled case (halfLife <= 0 or non-finite → 1).
   */
  private sessionAgeWeight(
    session: EnhancedPathRecord[],
    now: number = Date.now(),
  ): number {
    const firstRecord = session[0];
    if (!firstRecord) return 1;
    const ageMs = now - firstRecord.timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDecayWeight(ageDays, this.decayHalfLifeDays, 'e');
  }

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

  /**
   * @param now Current time in epoch ms, used for age decay. Injectable for
   *   deterministic tests; defaults to `Date.now()`. A single clock is shared by
   *   the weighted tally (reasoning/tiebreaker) and the kernel scoring call so
   *   they never diverge by sub-millisecond drift.
   */
  getEdgeRecommendation(
    fromNodeId: NodeId,
    now: number = Date.now(),
  ): EdgeRecommendation | null {
    const outgoingEdges = this.tree.getOutgoingEdges(fromNodeId);
    if (outgoingEdges.length === 0) {
      return null;
    }

    const sessions = this.getAllSessions();

    // For each outgoing edge target, collect one HistoryRun per edge traversal
    // occurrence. The confidence-kernel re-derives the age-decay weight from each
    // run's timestamp, so we record the session's first-record timestamp (the
    // value the former inline decay read) rather than pre-summing weights here.
    // `successfulLengths` is retained separately because DP's efficiency factor
    // is GLOBAL (tree-wide shortest / edge-avg), not a per-run steps notion —
    // the kernel's default efficiencyFactor cannot reproduce it, so we compute
    // the number ourselves and pass it to scoreHistory.
    const edgeOutcomes = new Map<
      string,
      {
        edgeId: string;
        targetNodeId: NodeId;
        runs: HistoryRun[];
        successes: number; // weighted sum — reasoning/tiebreaker only
        total: number; // weighted sum — reasoning/tiebreaker only
        successfulLengths: number[];
      }
    >();

    for (const edge of outgoingEdges) {
      edgeOutcomes.set(edge.id, {
        edgeId: edge.id,
        targetNodeId: edge.targetId,
        runs: [],
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

    let runSeq = 0;
    for (const session of sessions) {
      // Per-session age-decay weight (kernel-backed). Recorded into each run's
      // timestamp so scoreHistory re-derives the identical weight; also summed
      // directly for the reasoning string and the sample-count tiebreaker.
      const weight = this.sessionAgeWeight(session, now);
      const sessionTimestamp = session[0]?.timestamp ?? now;

      for (let i = 0; i < session.length - 1; i++) {
        const record = session[i] as EnhancedPathRecord;
        const nextRecord = session[i + 1] as EnhancedPathRecord;

        if (record.nodeId === fromNodeId) {
          // Find which edge was taken based on the next node
          for (const edge of outgoingEdges) {
            if (edge.targetId === nextRecord.nodeId) {
              const outcomes = edgeOutcomes.get(edge.id);
              if (outcomes) {
                // Check if the rest of the session from this point was successful
                const remainingRecords = session.slice(i + 1);
                const allSuccessful = remainingRecords.every(
                  (r) => r.status === 'success' || r.status === 'pending',
                );
                outcomes.total += weight;
                outcomes.runs.push({
                  id: `${edge.id}#${runSeq++}`,
                  timestamp: sessionTimestamp,
                  outcome: allSuccessful ? 'success' : 'failure',
                });
                if (allSuccessful) {
                  outcomes.successes += weight;
                  outcomes.successfulLengths.push(session.length);
                }
              }
              break;
            }
          }
        }
      }
    }

    // Composite confidence per edge: rate × sample × efficiency.
    // Delegated to the shared confidence-kernel (posture 'skip', e-decay,
    // saturationRuns 10, halfLife = this.decayHalfLifeDays). The kernel reproduces
    // the former inline `rate × min(total/10,1) × efficiencyFactor` bit-for-bit;
    // the efficiency factor stays host-computed (GLOBAL shortest / edge-avg) and
    // is passed through as the `efficiency` number.
    const computeConfidence = (outcomes: {
      runs: HistoryRun[];
      successfulLengths: number[];
    }): number => {
      let efficiency = 1;
      if (
        outcomes.successfulLengths.length > 0 &&
        shortestSuccessLength !== Number.POSITIVE_INFINITY
      ) {
        const avgLen =
          outcomes.successfulLengths.reduce((a, b) => a + b, 0) /
          outcomes.successfulLengths.length;
        efficiency = shortestSuccessLength / avgLen;
      }

      const result = scoreHistory(outcomes.runs, {
        posture: 'skip',
        halfLifeDays: this.decayHalfLifeDays,
        saturationRuns: 10,
        decayBase: 'e',
        efficiency,
        now,
      });
      return result ? result.confidence : 0;
    };

    /**
     * DRIFT DEMOTION (kernel `detectDrift`).
     *
     * The composite score above is age-decayed, so an edge that used to work
     * and just collapsed keeps a high number until decay slowly catches up —
     * long enough to keep skipping the LLM onto a path that now fails.
     * `detectDrift` compares the edge's most recent `driftRecentN` traversals
     * (unweighted) against its lifetime rate and flags a collapse.
     *
     * Mechanism: CLAMP the drifted edge's confidence to `driftDemotedCeiling`
     * (0.5 by default) rather than excluding it from selection. Rationale:
     *   - Clamping happens BEFORE best-edge selection, so a healthy sibling
     *     edge that scores above the ceiling naturally overtakes the drifted
     *     one — which is what exclusion would have achieved anyway.
     *   - But when the drifted edge is the *only* candidate we still return it,
     *     with an honest sub-override number, instead of returning `null` and
     *     losing the ranking/reasoning consumers rely on.
     *   - 0.5 sits below the 0.6 LLM-skip override (so a drifted edge can never
     *     trigger the skip) yet above the 0.2 prompt-bias tier (so the LLM is
     *     still told what history used to prefer). Demote, don't erase.
     */
    const driftFor = (runs: HistoryRun[]): boolean =>
      detectDrift(runs, {
        recentN: this.driftRecentN,
        driftThreshold: this.driftThreshold,
        minRuns: this.driftMinRuns,
      }).drifted;

    // Find the best edge (highest composite confidence, with sample count as tiebreaker)
    let bestEdge:
      | {
          edgeId: string;
          targetNodeId: NodeId;
          runs: HistoryRun[];
          successes: number;
          total: number;
          successfulLengths: number[];
        }
      | undefined;
    let bestConfidence = -1;
    let bestRate = -1;
    let bestDrifted = false;

    const allEdgeResults: Array<{
      edgeId: string;
      targetNodeId: NodeId;
      confidence: number;
      drifted: boolean;
    }> = [];

    for (const outcomes of edgeOutcomes.values()) {
      let conf = computeConfidence(outcomes);
      const drifted = driftFor(outcomes.runs);
      if (drifted && this.driftDemotion) {
        conf = Math.min(conf, this.driftDemotedCeiling);
      }
      const rate = outcomes.total > 0 ? outcomes.successes / outcomes.total : 0;
      allEdgeResults.push({
        edgeId: outcomes.edgeId,
        targetNodeId: outcomes.targetNodeId,
        confidence: conf,
        drifted,
      });
      if (
        conf > bestConfidence ||
        (conf === bestConfidence && outcomes.total > (bestEdge?.total ?? 0))
      ) {
        bestConfidence = conf;
        bestRate = rate;
        bestDrifted = drifted;
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
    const driftNote = bestDrifted
      ? ` DRIFT: recent success rate collapsed vs lifetime (last ${this.driftRecentN} runs, threshold ${this.driftThreshold})${this.driftDemotion ? ` — confidence demoted to <=${this.driftDemotedCeiling}` : ''}.`
      : '';
    const reasoning =
      totalSamples > 0
        ? `Edge "${bestEdge.edgeId}" succeeded in ${bestEdge.successes}/${totalSamples} sessions (${(bestRate * 100).toFixed(1)}% rate, avg path length ${avgLen.toFixed(1)}, shortest known ${shortestSuccessLength === Number.POSITIVE_INFINITY ? 'n/a' : shortestSuccessLength}).${driftNote}`
        : `No historical data available for edges from node "${fromNodeId}". Recommendation is based on default ordering.`;

    return {
      fromNodeId,
      recommendedEdgeId: bestEdge.edgeId,
      targetNodeId: bestEdge.targetNodeId,
      confidence,
      reasoning,
      drifted: bestDrifted,
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
