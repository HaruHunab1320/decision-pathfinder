import type {
  IDecisionTree,
  IEdge,
  IEnhancedPathTracker,
  INode,
  NodeId,
} from '../core/interfaces.js';
import type {
  DecisionContext,
  DecisionOutcome,
  ILLMDecisionTreeAdapter,
  TreeRecommendation,
} from './ILLMDecisionTreeAdapter.js';

export class MockLLMAdapter implements ILLMDecisionTreeAdapter {
  private tree: IDecisionTree;
  private tracker: IEnhancedPathTracker;
  private treeId: string | null = null;

  constructor(tree: IDecisionTree, tracker: IEnhancedPathTracker) {
    this.tree = tree;
    this.tracker = tracker;
  }

  async initialize(treeId: string): Promise<void> {
    this.treeId = treeId;
    this.tracker.startSession();
  }

  async getDecisionContext(currentNodeId: NodeId): Promise<DecisionContext> {
    const currentNode = this.tree.getNode(currentNodeId);
    if (!currentNode) {
      throw new Error(`Node "${currentNodeId}" not found in tree`);
    }

    const availableEdges = this.tree.getOutgoingEdges(currentNodeId);
    const availableNextNodes: INode[] = [];
    for (const edge of availableEdges) {
      const targetNode = this.tree.getNode(edge.targetId);
      if (targetNode) {
        availableNextNodes.push(targetNode);
      }
    }

    return {
      currentNodeId,
      currentNode,
      availableEdges,
      availableNextNodes,
      pathHistory: this.tracker.getVisitedNodeIds(),
      metadata: currentNode.metadata,
    };
  }

  async submitOutcome(outcome: DecisionOutcome): Promise<void> {
    const status =
      outcome.status === 'success'
        ? ('success' as const)
        : outcome.status === 'failure'
          ? ('failure' as const)
          : ('pending' as const);

    this.tracker.recordEnhancedVisit(outcome.targetNodeId, status, {
      toolOutput: outcome.output,
      ...(outcome.reasoning !== undefined
        ? { reasoning: outcome.reasoning }
        : {}),
    });
  }

  async getRecommendation(
    currentNodeId: NodeId,
  ): Promise<TreeRecommendation | null> {
    const outgoingEdges = this.tree.getOutgoingEdges(currentNodeId);
    if (outgoingEdges.length === 0) {
      return null;
    }

    const sessions = this.tracker.getAllSessions();
    const totalVisits = sessions.reduce(
      (sum, session) => sum + session.length,
      0,
    );
    if (totalVisits === 0) {
      return null;
    }

    // Pick the edge with the highest weight, defaulting to 1
    let bestEdge: IEdge = outgoingEdges[0]!;
    let bestWeight = bestEdge.weight ?? 1;

    for (let i = 1; i < outgoingEdges.length; i++) {
      const edge = outgoingEdges[i]!;
      const weight = edge.weight ?? 1;
      if (weight > bestWeight) {
        bestEdge = edge;
        bestWeight = weight;
      }
    }

    // Compute confidence based on how many times the target was visited successfully
    const targetVisitCount = this.tracker.getNodeVisitCount(bestEdge.targetId);
    const successRate = this.tracker.getSuccessRate();
    const confidence =
      totalVisits > 0
        ? Math.min(
            1,
            (targetVisitCount / totalVisits) * 0.5 + successRate * 0.5,
          )
        : 0;

    return {
      recommendedEdgeId: bestEdge.id,
      targetNodeId: bestEdge.targetId,
      confidence,
      reasoning: `Recommended based on edge weight (${bestWeight}) and historical success rate (${(successRate * 100).toFixed(1)}%)`,
      basedOnSampleSize: totalVisits,
    };
  }

  async getPathHistory(): Promise<NodeId[]> {
    return this.tracker.getVisitedNodeIds();
  }

  async reset(): Promise<void> {
    this.tracker.endSession();
    this.tracker.reset();
    this.treeId = null;
  }
}
