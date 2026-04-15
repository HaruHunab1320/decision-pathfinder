import { beforeEach, describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge, INode } from '../core/interfaces.js';

function makeNode(id: string, label?: string): INode {
  return { id, type: 'test', label: label ?? id, metadata: {} };
}

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  weight?: number,
): IEdge {
  return { id, sourceId, targetId, metadata: {}, weight };
}

describe('DecisionTree', () => {
  let tree: DecisionTree;

  beforeEach(() => {
    tree = new DecisionTree();
  });

  // --- Node operations ---

  describe('addNode / removeNode', () => {
    it('adds a node and retrieves it', () => {
      const node = makeNode('n1');
      tree.addNode(node);
      expect(tree.hasNode('n1')).toBe(true);
      expect(tree.getNode('n1')).toBe(node);
      expect(tree.nodeCount).toBe(1);
    });

    it('throws on duplicate node id', () => {
      tree.addNode(makeNode('n1'));
      expect(() => tree.addNode(makeNode('n1'))).toThrow('already exists');
    });

    it('removes a node', () => {
      tree.addNode(makeNode('n1'));
      tree.removeNode('n1');
      expect(tree.hasNode('n1')).toBe(false);
      expect(tree.nodeCount).toBe(0);
    });

    it('removing non-existent node is a no-op', () => {
      expect(() => tree.removeNode('nope')).not.toThrow();
    });

    it('removing a node removes connected edges', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'b', 'c'));

      tree.removeNode('b');

      expect(tree.edgeCount).toBe(0);
      expect(tree.getEdge('e1')).toBeUndefined();
      expect(tree.getEdge('e2')).toBeUndefined();
    });
  });

  // --- Edge operations ---

  describe('addEdge / removeEdge', () => {
    it('adds an edge between existing nodes', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      expect(tree.edgeCount).toBe(1);
      expect(tree.getEdge('e1')).toBeDefined();
    });

    it('throws when source node does not exist', () => {
      tree.addNode(makeNode('b'));
      expect(() => tree.addEdge(makeEdge('e1', 'missing', 'b'))).toThrow(
        'Source node',
      );
    });

    it('throws when target node does not exist', () => {
      tree.addNode(makeNode('a'));
      expect(() => tree.addEdge(makeEdge('e1', 'a', 'missing'))).toThrow(
        'Target node',
      );
    });

    it('throws on duplicate edge id', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      expect(() => tree.addEdge(makeEdge('e1', 'a', 'b'))).toThrow(
        'already exists',
      );
    });

    it('removes an edge', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.removeEdge('e1');
      expect(tree.edgeCount).toBe(0);
      expect(tree.getEdge('e1')).toBeUndefined();
    });

    it('removing non-existent edge is a no-op', () => {
      expect(() => tree.removeEdge('nope')).not.toThrow();
    });

    it('getOutgoingEdges returns correct edges', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'a', 'c'));
      const edges = tree.getOutgoingEdges('a');
      expect(edges).toHaveLength(2);
    });

    it('getIncomingEdges returns correct edges', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addEdge(makeEdge('e1', 'a', 'c'));
      tree.addEdge(makeEdge('e2', 'b', 'c'));
      const edges = tree.getIncomingEdges('c');
      expect(edges).toHaveLength(2);
    });
  });

  // --- Root / Leaf nodes ---

  describe('getRootNodes / getLeafNodes', () => {
    it('identifies root nodes (no incoming edges)', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'b', 'c'));

      const roots = tree.getRootNodes();
      expect(roots).toHaveLength(1);
      expect(roots[0]?.id).toBe('a');
    });

    it('identifies leaf nodes (no outgoing edges)', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'b', 'c'));

      const leaves = tree.getLeafNodes();
      expect(leaves).toHaveLength(1);
      expect(leaves[0]?.id).toBe('c');
    });

    it('isolated node is both root and leaf', () => {
      tree.addNode(makeNode('solo'));
      expect(tree.getRootNodes()).toHaveLength(1);
      expect(tree.getLeafNodes()).toHaveLength(1);
    });
  });

  // --- Traversal ---

  describe('traverse', () => {
    beforeEach(() => {
      // Build: a -> b -> d
      //        a -> c -> d
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addNode(makeNode('d'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'a', 'c'));
      tree.addEdge(makeEdge('e3', 'b', 'd'));
      tree.addEdge(makeEdge('e4', 'c', 'd'));
    });

    it('DFS visits nodes in depth-first order', () => {
      const visited: string[] = [];
      tree.traverse('a', 'depth-first', (node) => {
        visited.push(node.id);
      });
      // a first, then either branch fully before the other
      expect(visited[0]).toBe('a');
      expect(visited).toContain('b');
      expect(visited).toContain('c');
      expect(visited).toContain('d');
      expect(visited).toHaveLength(4);
    });

    it('BFS visits nodes in breadth-first order', () => {
      const visited: string[] = [];
      tree.traverse('a', 'breadth-first', (node) => {
        visited.push(node.id);
      });
      // a first, then b and c (depth 1), then d (depth 2)
      expect(visited[0]).toBe('a');
      expect(visited.indexOf('b')).toBeLessThan(visited.indexOf('d'));
      expect(visited.indexOf('c')).toBeLessThan(visited.indexOf('d'));
      expect(visited).toHaveLength(4);
    });

    it('visitor returning false stops DFS traversal early', () => {
      const visited: string[] = [];
      tree.traverse('a', 'depth-first', (node) => {
        visited.push(node.id);
        if (node.id === 'b') return false;
      });
      // Should stop after visiting b
      expect(visited).toContain('a');
      expect(visited).toContain('b');
      expect(visited.length).toBeLessThanOrEqual(2);
    });

    it('visitor returning false stops BFS traversal early', () => {
      const visited: string[] = [];
      tree.traverse('a', 'breadth-first', (node) => {
        visited.push(node.id);
        if (node.id === 'b') return false;
      });
      expect(visited).toContain('b');
      expect(visited).not.toContain('d');
    });

    it('handles cycles without infinite loop', () => {
      // Add cycle: d -> a
      tree.addEdge(makeEdge('e_cycle', 'd', 'a'));

      const visited: string[] = [];
      tree.traverse('a', 'depth-first', (node) => {
        visited.push(node.id);
      });
      // Should visit each node exactly once
      expect(visited).toHaveLength(4);
    });

    it('handles cycles in BFS without infinite loop', () => {
      tree.addEdge(makeEdge('e_cycle', 'd', 'a'));

      const visited: string[] = [];
      tree.traverse('a', 'breadth-first', (node) => {
        visited.push(node.id);
      });
      expect(visited).toHaveLength(4);
    });

    it('throws if start node does not exist', () => {
      expect(() => tree.traverse('missing', 'depth-first', () => {})).toThrow(
        'does not exist',
      );
    });
  });

  // --- findPath ---

  describe('findPath', () => {
    beforeEach(() => {
      // a -> b -> c -> d
      //      b -> d  (shortcut)
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addNode(makeNode('c'));
      tree.addNode(makeNode('d'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.addEdge(makeEdge('e2', 'b', 'c'));
      tree.addEdge(makeEdge('e3', 'c', 'd'));
      tree.addEdge(makeEdge('e4', 'b', 'd')); // shortcut
    });

    it('finds shortest path', () => {
      const path = tree.findPath('a', 'd');
      // shortest is a -> b -> d (length 3), not a -> b -> c -> d (length 4)
      expect(path).toEqual(['a', 'b', 'd']);
    });

    it('returns path to self', () => {
      expect(tree.findPath('a', 'a')).toEqual(['a']);
    });

    it('returns null for unreachable nodes', () => {
      tree.addNode(makeNode('isolated'));
      expect(tree.findPath('a', 'isolated')).toBeNull();
    });

    it('returns null when from node does not exist', () => {
      expect(tree.findPath('missing', 'a')).toBeNull();
    });

    it('returns null when to node does not exist', () => {
      expect(tree.findPath('a', 'missing')).toBeNull();
    });
  });

  // --- nodeCount / edgeCount ---

  describe('nodeCount / edgeCount', () => {
    it('starts at zero', () => {
      expect(tree.nodeCount).toBe(0);
      expect(tree.edgeCount).toBe(0);
    });

    it('tracks additions correctly', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      expect(tree.nodeCount).toBe(2);
      expect(tree.edgeCount).toBe(1);
    });

    it('tracks removals correctly', () => {
      tree.addNode(makeNode('a'));
      tree.addNode(makeNode('b'));
      tree.addEdge(makeEdge('e1', 'a', 'b'));
      tree.removeEdge('e1');
      expect(tree.edgeCount).toBe(0);
      tree.removeNode('b');
      expect(tree.nodeCount).toBe(1);
    });
  });
});
