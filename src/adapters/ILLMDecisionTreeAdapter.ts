import type { IEdge, INode, NodeId, NodeMetadata } from '../core/interfaces.js';

// Decision context provided to the LLM
export interface DecisionContext {
  currentNodeId: NodeId;
  currentNode: INode;
  availableEdges: IEdge[];
  availableNextNodes: INode[];
  pathHistory: NodeId[];
  metadata: NodeMetadata;
}

// Outcome submitted by the LLM after making a decision
export interface DecisionOutcome {
  chosenEdgeId: string;
  targetNodeId: NodeId;
  status: 'success' | 'failure' | 'pending';
  output?: unknown;
  reasoning?: string;
  timestamp: number;
}

// Recommendation from the tree based on historical data
export interface TreeRecommendation {
  recommendedEdgeId: string;
  targetNodeId: NodeId;
  confidence: number; // 0-1 scale
  reasoning: string;
  basedOnSampleSize: number;
}

// The adapter interface that LLMs implement to interact with the tree
export interface ILLMDecisionTreeAdapter {
  // Initialize with a decision tree
  initialize(treeId: string): Promise<void>;

  // Get the current decision context (what node am I at, what are my options?)
  getDecisionContext(currentNodeId: NodeId): Promise<DecisionContext>;

  // Submit the outcome of a decision
  submitOutcome(outcome: DecisionOutcome): Promise<void>;

  // Get recommendation for next best action based on historical data
  getRecommendation(currentNodeId: NodeId): Promise<TreeRecommendation | null>;

  // Get the full path taken so far
  getPathHistory(): Promise<NodeId[]>;

  // Reset the adapter state
  reset(): Promise<void>;
}
