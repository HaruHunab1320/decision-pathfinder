// Unique identifier types
export type NodeId = string;
export type EdgeId = string;

// Metadata that can be attached to any node
export interface NodeMetadata {
  [key: string]: unknown;
}

// Base node interface - all node types extend this
export interface INode {
  id: NodeId;
  type: string;
  label: string;
  metadata: NodeMetadata;
}

// Edge connecting two nodes, with optional condition
export interface IEdge {
  id: EdgeId;
  sourceId: NodeId;
  targetId: NodeId;
  condition?: string | undefined; // human-readable condition label
  weight?: number | undefined; // optional priority/weight
  metadata: NodeMetadata;
}

// Traversal order options
export type TraversalOrder = 'depth-first' | 'breadth-first';

// Callback for traversal visitors
// Returning false stops traversal
export type TraversalVisitor = (
  node: INode,
  depth: number,
  path: NodeId[],
) => undefined | boolean;

// Core decision tree interface
export interface IDecisionTree {
  addNode(node: INode): void;
  removeNode(id: NodeId): void;
  getNode(id: NodeId): INode | undefined;
  hasNode(id: NodeId): boolean;

  addEdge(edge: IEdge): void;
  removeEdge(id: EdgeId): void;
  getEdge(id: EdgeId): IEdge | undefined;
  getOutgoingEdges(nodeId: NodeId): IEdge[];
  getIncomingEdges(nodeId: NodeId): IEdge[];

  getRootNodes(): INode[]; // nodes with no incoming edges
  getLeafNodes(): INode[]; // nodes with no outgoing edges

  traverse(
    startNodeId: NodeId,
    order: TraversalOrder,
    visitor: TraversalVisitor,
  ): void;
  findPath(fromId: NodeId, toId: NodeId): NodeId[] | null;

  readonly nodeCount: number;
  readonly edgeCount: number;
}

// Path record for tracking
export interface PathRecord {
  nodeId: NodeId;
  timestamp: number;
  metadata: NodeMetadata;
}

// PathTracker interface
export interface IPathTracker {
  recordVisit(nodeId: NodeId, metadata?: NodeMetadata): void;
  getPath(): PathRecord[];
  getVisitedNodeIds(): NodeId[];
  reset(): void;
}

// Visit status for enhanced tracking
export type VisitStatus = 'success' | 'failure' | 'pending' | 'skipped';

// Enhanced path record with metrics
export interface EnhancedPathRecord extends PathRecord {
  status: VisitStatus;
  duration?: number; // time spent at this node in ms
  toolOutput?: unknown; // output from tool calls
  searchResults?: unknown; // search/query results
  error?: string; // error message if failed
}

// Enhanced PathTracker interface
export interface IEnhancedPathTracker extends IPathTracker {
  recordEnhancedVisit(
    nodeId: NodeId,
    status: VisitStatus,
    metadata?: NodeMetadata & {
      duration?: number;
      toolOutput?: unknown;
      searchResults?: unknown;
      error?: string;
    },
  ): void;
  getEnhancedPath(): EnhancedPathRecord[];
  getSuccessRate(): number; // ratio of successful visits
  getFailedNodes(): NodeId[];
  getNodeVisitCount(nodeId: NodeId): number;
  getAveragePathLength(): number; // across all recorded sessions
  startSession(): void; // start a new tracking session
  endSession(): void; // end current session
  getAllSessions(): EnhancedPathRecord[][];
}

/** Metadata attached to a tree for family grouping and discovery. */
export interface TreeMetadata {
  family?: string;
  tags?: string[];
  description?: string;
  taskName?: string;
  createdAt?: string;
}
