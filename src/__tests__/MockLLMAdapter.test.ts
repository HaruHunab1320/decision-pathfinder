import { beforeEach, describe, expect, it } from 'vitest';
import { MockLLMAdapter } from '../adapters/MockLLMAdapter.js';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge } from '../core/interfaces.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';
import { PathTracker } from '../tracking/PathTracker.js';

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  weight?: number,
): IEdge {
  return { id, sourceId, targetId, metadata: {}, weight };
}

describe('MockLLMAdapter', () => {
  let tree: DecisionTree;
  let tracker: PathTracker;
  let adapter: MockLLMAdapter;

  beforeEach(() => {
    tree = new DecisionTree();
    tracker = new PathTracker();
    adapter = new MockLLMAdapter(tree, tracker);

    // Build a small tree:
    //   start (conversation) --e1--> tool (tool_call) --e2--> done (success)
    //                         --e3--> altDone (success)
    tree.addNode(new ConversationNode('start', 'Start', { prompt: 'Hello' }));
    tree.addNode(
      new ToolCallNode('tool', 'Run Tool', {
        toolName: 'search',
        parameters: { q: 'test' },
      }),
    );
    tree.addNode(new SuccessNode('done', 'Done', { message: 'Completed' }));
    tree.addNode(
      new SuccessNode('altDone', 'Alt Done', { message: 'Alt path' }),
    );

    tree.addEdge(makeEdge('e1', 'start', 'tool'));
    tree.addEdge(makeEdge('e2', 'tool', 'done', 5));
    tree.addEdge(makeEdge('e3', 'start', 'altDone', 1));
  });

  describe('initialize', () => {
    it('initializes without error', async () => {
      await expect(adapter.initialize('tree-1')).resolves.not.toThrow();
    });
  });

  describe('getDecisionContext', () => {
    it('returns correct context for a node', async () => {
      await adapter.initialize('tree-1');
      const ctx = await adapter.getDecisionContext('start');

      expect(ctx.currentNodeId).toBe('start');
      expect(ctx.currentNode.id).toBe('start');
      expect(ctx.availableEdges).toHaveLength(2);
      expect(ctx.availableNextNodes).toHaveLength(2);
      expect(ctx.pathHistory).toEqual([]);
    });

    it('throws for non-existent node', async () => {
      await adapter.initialize('tree-1');
      await expect(adapter.getDecisionContext('missing')).rejects.toThrow(
        'not found',
      );
    });

    it('includes path history after visits', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        timestamp: Date.now(),
      });

      const ctx = await adapter.getDecisionContext('tool');
      expect(ctx.pathHistory).toContain('tool');
    });
  });

  describe('submitOutcome', () => {
    it('records the outcome in the tracker', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        output: { result: 'found' },
        reasoning: 'Best option',
        timestamp: Date.now(),
      });

      const path = tracker.getEnhancedPath();
      expect(path).toHaveLength(1);
      expect(path[0]?.nodeId).toBe('tool');
      expect(path[0]?.status).toBe('success');
      expect(path[0]?.toolOutput).toEqual({ result: 'found' });
    });

    it('records failure status', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'failure',
        timestamp: Date.now(),
      });

      const path = tracker.getEnhancedPath();
      expect(path[0]?.status).toBe('failure');
    });
  });

  describe('getPathHistory', () => {
    it('returns empty path initially', async () => {
      await adapter.initialize('tree-1');
      const history = await adapter.getPathHistory();
      expect(history).toEqual([]);
    });

    it('returns visited nodes after outcomes', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        timestamp: Date.now(),
      });

      await adapter.submitOutcome({
        chosenEdgeId: 'e2',
        targetNodeId: 'done',
        status: 'success',
        timestamp: Date.now(),
      });

      const history = await adapter.getPathHistory();
      expect(history).toEqual(['tool', 'done']);
    });
  });

  describe('getRecommendation', () => {
    it('returns null when no history exists', async () => {
      await adapter.initialize('tree-1');
      const rec = await adapter.getRecommendation('start');
      expect(rec).toBeNull();
    });

    it('returns a recommendation after some history', async () => {
      await adapter.initialize('tree-1');

      // Record some visits to build history
      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        timestamp: Date.now(),
      });

      const rec = await adapter.getRecommendation('start');
      expect(rec).not.toBeNull();
      expect(rec?.recommendedEdgeId).toBeDefined();
      expect(rec?.targetNodeId).toBeDefined();
      expect(rec?.confidence).toBeGreaterThanOrEqual(0);
      expect(rec?.confidence).toBeLessThanOrEqual(1);
      expect(typeof rec?.reasoning).toBe('string');
      expect(rec?.basedOnSampleSize).toBeGreaterThan(0);
    });

    it('recommends the edge with highest weight', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        timestamp: Date.now(),
      });

      // From 'tool' node, only edge is e2 with weight 5
      const rec = await adapter.getRecommendation('tool');
      expect(rec).not.toBeNull();
      expect(rec?.recommendedEdgeId).toBe('e2');
      expect(rec?.targetNodeId).toBe('done');
    });

    it('returns null for leaf nodes with no outgoing edges', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e2',
        targetNodeId: 'done',
        status: 'success',
        timestamp: Date.now(),
      });

      const rec = await adapter.getRecommendation('done');
      expect(rec).toBeNull();
    });
  });

  describe('reset', () => {
    it('clears all state', async () => {
      await adapter.initialize('tree-1');

      await adapter.submitOutcome({
        chosenEdgeId: 'e1',
        targetNodeId: 'tool',
        status: 'success',
        timestamp: Date.now(),
      });

      await adapter.reset();

      const history = await adapter.getPathHistory();
      expect(history).toEqual([]);

      expect(tracker.getAllSessions()).toEqual([]);
    });
  });
});
