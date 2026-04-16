import type { IEdge, INode, NodeId, NodeMetadata } from '../core/interfaces.js';

/**
 * Decision context passed to an IDecisionMaker at each branch point.
 * Contains everything needed to choose an outgoing edge.
 */
export interface DecisionContext {
  currentNodeId: NodeId;
  currentNode: INode;
  availableEdges: IEdge[];
  availableNextNodes: INode[];
  pathHistory: NodeId[];
  metadata: NodeMetadata;
}
