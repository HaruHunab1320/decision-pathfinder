import type {
  EdgeId,
  IDecisionTree,
  IEdge,
  INode,
  NodeId,
  TraversalOrder,
  TraversalVisitor,
} from './interfaces.js';

export class DecisionTree implements IDecisionTree {
  private nodes: Map<NodeId, INode> = new Map();
  private edges: Map<EdgeId, IEdge> = new Map();
  private outgoing: Map<NodeId, Set<EdgeId>> = new Map();
  private incoming: Map<NodeId, Set<EdgeId>> = new Map();

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  getAllNodes(): INode[] {
    return Array.from(this.nodes.values());
  }

  getAllEdges(): IEdge[] {
    return Array.from(this.edges.values());
  }

  addNode(node: INode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Node with id "${node.id}" already exists`);
    }
    this.nodes.set(node.id, node);
    this.outgoing.set(node.id, new Set());
    this.incoming.set(node.id, new Set());
  }

  removeNode(id: NodeId): void {
    if (!this.nodes.has(id)) {
      return;
    }

    // Remove all connected edges
    const outEdges = this.outgoing.get(id);
    if (outEdges) {
      for (const edgeId of [...outEdges]) {
        this.removeEdge(edgeId);
      }
    }

    const inEdges = this.incoming.get(id);
    if (inEdges) {
      for (const edgeId of [...inEdges]) {
        this.removeEdge(edgeId);
      }
    }

    this.nodes.delete(id);
    this.outgoing.delete(id);
    this.incoming.delete(id);
  }

  getNode(id: NodeId): INode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  addEdge(edge: IEdge): void {
    if (!this.nodes.has(edge.sourceId)) {
      throw new Error(`Source node "${edge.sourceId}" does not exist`);
    }
    if (!this.nodes.has(edge.targetId)) {
      throw new Error(`Target node "${edge.targetId}" does not exist`);
    }
    if (this.edges.has(edge.id)) {
      throw new Error(`Edge with id "${edge.id}" already exists`);
    }

    this.edges.set(edge.id, edge);
    this.outgoing.get(edge.sourceId)?.add(edge.id);
    this.incoming.get(edge.targetId)?.add(edge.id);
  }

  removeEdge(id: EdgeId): void {
    const edge = this.edges.get(id);
    if (!edge) {
      return;
    }

    this.outgoing.get(edge.sourceId)?.delete(id);
    this.incoming.get(edge.targetId)?.delete(id);
    this.edges.delete(id);
  }

  getEdge(id: EdgeId): IEdge | undefined {
    return this.edges.get(id);
  }

  getOutgoingEdges(nodeId: NodeId): IEdge[] {
    const edgeIds = this.outgoing.get(nodeId);
    if (!edgeIds) {
      return [];
    }
    const result: IEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        result.push(edge);
      }
    }
    return result;
  }

  getIncomingEdges(nodeId: NodeId): IEdge[] {
    const edgeIds = this.incoming.get(nodeId);
    if (!edgeIds) {
      return [];
    }
    const result: IEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        result.push(edge);
      }
    }
    return result;
  }

  getRootNodes(): INode[] {
    const roots: INode[] = [];
    for (const [nodeId, node] of this.nodes) {
      const inEdges = this.incoming.get(nodeId);
      if (!inEdges || inEdges.size === 0) {
        roots.push(node);
      }
    }
    return roots;
  }

  getLeafNodes(): INode[] {
    const leaves: INode[] = [];
    for (const [nodeId, node] of this.nodes) {
      const outEdges = this.outgoing.get(nodeId);
      if (!outEdges || outEdges.size === 0) {
        leaves.push(node);
      }
    }
    return leaves;
  }

  traverse(
    startNodeId: NodeId,
    order: TraversalOrder,
    visitor: TraversalVisitor,
  ): void {
    const startNode = this.nodes.get(startNodeId);
    if (!startNode) {
      throw new Error(`Start node "${startNodeId}" does not exist`);
    }

    const visited = new Set<NodeId>();

    if (order === 'depth-first') {
      this.traverseDepthFirst(startNodeId, visited, visitor);
    } else {
      this.traverseBreadthFirst(startNodeId, visited, visitor);
    }
  }

  private traverseDepthFirst(
    startNodeId: NodeId,
    visited: Set<NodeId>,
    visitor: TraversalVisitor,
  ): void {
    // Iterative DFS using a stack
    // Stack entries: [nodeId, depth, path]
    const stack: Array<[NodeId, number, NodeId[]]> = [[startNodeId, 0, []]];

    while (stack.length > 0) {
      const entry = stack.pop()!;
      const [nodeId, depth, path] = entry;

      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      const node = this.nodes.get(nodeId);
      if (!node) {
        continue;
      }

      const currentPath = [...path, nodeId];
      const result = visitor(node, depth, currentPath);
      if (result === false) {
        return;
      }

      // Push children in reverse order so first child is processed first
      const outEdges = this.getOutgoingEdges(nodeId);
      for (let i = outEdges.length - 1; i >= 0; i--) {
        const edge = outEdges[i]!;
        if (!visited.has(edge.targetId)) {
          stack.push([edge.targetId, depth + 1, currentPath]);
        }
      }
    }
  }

  private traverseBreadthFirst(
    startNodeId: NodeId,
    visited: Set<NodeId>,
    visitor: TraversalVisitor,
  ): void {
    // BFS using a queue
    const queue: Array<[NodeId, number, NodeId[]]> = [[startNodeId, 0, []]];

    visited.add(startNodeId);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const [nodeId, depth, path] = entry;

      const node = this.nodes.get(nodeId);
      if (!node) {
        continue;
      }

      const currentPath = [...path, nodeId];
      const result = visitor(node, depth, currentPath);
      if (result === false) {
        return;
      }

      for (const edge of this.getOutgoingEdges(nodeId)) {
        if (!visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          queue.push([edge.targetId, depth + 1, currentPath]);
        }
      }
    }
  }

  findPath(fromId: NodeId, toId: NodeId): NodeId[] | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
      return null;
    }

    if (fromId === toId) {
      return [fromId];
    }

    // BFS for shortest path
    const visited = new Set<NodeId>();
    const parent = new Map<NodeId, NodeId>();
    const queue: NodeId[] = [fromId];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const edge of this.getOutgoingEdges(current)) {
        if (!visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          parent.set(edge.targetId, current);

          if (edge.targetId === toId) {
            // Reconstruct path
            const path: NodeId[] = [toId];
            let node: NodeId | undefined = toId;
            while (node !== undefined && node !== fromId) {
              node = parent.get(node);
              if (node !== undefined) {
                path.unshift(node);
              }
            }
            return path;
          }

          queue.push(edge.targetId);
        }
      }
    }

    return null;
  }
}
