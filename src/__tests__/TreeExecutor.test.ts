import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge } from '../core/interfaces.js';
import type { ExecutionEvents } from '../execution/TreeExecutor.js';
import { MockDecisionMaker, TreeExecutor } from '../execution/TreeExecutor.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';
import { PathTracker } from '../tracking/PathTracker.js';

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  condition?: string,
): IEdge {
  return { id, sourceId, targetId, metadata: {}, condition };
}

describe('TreeExecutor', () => {
  let tree: DecisionTree;
  let tracker: PathTracker;

  beforeEach(() => {
    tree = new DecisionTree();
    tracker = new PathTracker();
  });

  describe('linear tree walk', () => {
    it('walks a simple linear tree to success', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Hello' });
      const n2 = new SuccessNode('n2', 'Done', { message: 'Completed' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      const result = await executor.execute('n1');

      expect(result.status).toBe('success');
      expect(result.finalNodeId).toBe('n2');
      expect(result.pathTaken).toEqual(['n1', 'n2']);
      expect(result.stepCount).toBe(2);
    });

    it('walks to a failure node', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Hello' });
      const n2 = new FailureNode('n2', 'Failed', {
        message: 'Error',
        recoverable: false,
      });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      const result = await executor.execute('n1');

      expect(result.status).toBe('failure');
      expect(result.finalNodeId).toBe('n2');
    });

    it('walks a three-node linear tree', async () => {
      const n1 = new ConversationNode('n1', 'Step 1', { prompt: 'First' });
      const n2 = new ConversationNode('n2', 'Step 2', { prompt: 'Second' });
      const n3 = new SuccessNode('n3', 'Done', { message: 'All done' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addNode(n3);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));
      tree.addEdge(makeEdge('e2', 'n2', 'n3'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      const result = await executor.execute('n1');

      expect(result.status).toBe('success');
      expect(result.pathTaken).toEqual(['n1', 'n2', 'n3']);
    });
  });

  describe('branching with MockDecisionMaker', () => {
    it('follows a predetermined path', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Choose' });
      const n2 = new SuccessNode('n2', 'Path A', { message: 'A' });
      const n3 = new SuccessNode('n3', 'Path B', { message: 'B' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addNode(n3);
      tree.addEdge(makeEdge('e1', 'n1', 'n2', 'go left'));
      tree.addEdge(makeEdge('e2', 'n1', 'n3', 'go right'));

      const decisionMaker = new MockDecisionMaker(['e2']);
      const executor = new TreeExecutor(tree, decisionMaker, tracker);
      const result = await executor.execute('n1');

      expect(result.status).toBe('success');
      expect(result.finalNodeId).toBe('n3');
      expect(result.pathTaken).toEqual(['n1', 'n3']);
    });

    it('defaults to first edge when no predetermined path', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Choose' });
      const n2 = new SuccessNode('n2', 'Path A', { message: 'A' });
      const n3 = new SuccessNode('n3', 'Path B', { message: 'B' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addNode(n3);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));
      tree.addEdge(makeEdge('e2', 'n1', 'n3'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      const result = await executor.execute('n1');

      expect(result.status).toBe('success');
      expect(result.finalNodeId).toBe('n2');
    });
  });

  describe('maxSteps', () => {
    it('stops when max steps exceeded', async () => {
      // Create a loop: n1 -> n2 -> n1 (circular)
      const n1 = new ConversationNode('n1', 'Loop A', { prompt: 'A' });
      const n2 = new ConversationNode('n2', 'Loop B', { prompt: 'B' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));
      tree.addEdge(makeEdge('e2', 'n2', 'n1'));

      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        { maxSteps: 5 },
      );
      const result = await executor.execute('n1');

      expect(result.status).toBe('max_steps_exceeded');
      expect(result.stepCount).toBe(5);
      expect(result.error).toContain('maximum steps');
    });
  });

  describe('ConditionalNode', () => {
    it('follows true branch when evaluator returns true', async () => {
      const cond = new ConditionalNode('c1', 'Check', {
        condition: 'isReady',
        evaluator: 'isReady',
      });
      const nTrue = new SuccessNode('t1', 'Yes', { message: 'Ready' });
      const nFalse = new FailureNode('f1', 'No', {
        message: 'Not ready',
        recoverable: true,
      });
      tree.addNode(cond);
      tree.addNode(nTrue);
      tree.addNode(nFalse);
      tree.addEdge(makeEdge('e-true', 'c1', 't1'));
      tree.addEdge(makeEdge('e-false', 'c1', 'f1'));
      cond.trueEdgeId = 'e-true';
      cond.falseEdgeId = 'e-false';

      const evaluators = new Map([['isReady', () => true]]);
      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        {
          conditionEvaluators: evaluators,
        },
      );
      const result = await executor.execute('c1');

      expect(result.status).toBe('success');
      expect(result.finalNodeId).toBe('t1');
    });

    it('follows false branch when evaluator returns false', async () => {
      const cond = new ConditionalNode('c1', 'Check', {
        condition: 'isReady',
        evaluator: 'isReady',
      });
      const nTrue = new SuccessNode('t1', 'Yes', { message: 'Ready' });
      const nFalse = new FailureNode('f1', 'No', {
        message: 'Not ready',
        recoverable: true,
      });
      tree.addNode(cond);
      tree.addNode(nTrue);
      tree.addNode(nFalse);
      tree.addEdge(makeEdge('e-true', 'c1', 't1'));
      tree.addEdge(makeEdge('e-false', 'c1', 'f1'));
      cond.trueEdgeId = 'e-true';
      cond.falseEdgeId = 'e-false';

      const evaluators = new Map([['isReady', () => false]]);
      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        {
          conditionEvaluators: evaluators,
        },
      );
      const result = await executor.execute('c1');

      expect(result.status).toBe('failure');
      expect(result.finalNodeId).toBe('f1');
    });

    it('falls back to LLM when no evaluator registered', async () => {
      const cond = new ConditionalNode('c1', 'Check', { condition: 'unknown' });
      const nA = new SuccessNode('a1', 'A', { message: 'A' });
      const nB = new SuccessNode('b1', 'B', { message: 'B' });
      tree.addNode(cond);
      tree.addNode(nA);
      tree.addNode(nB);
      tree.addEdge(makeEdge('e1', 'c1', 'a1'));
      tree.addEdge(makeEdge('e2', 'c1', 'b1'));

      const decisionMaker = new MockDecisionMaker(['e2']);
      const executor = new TreeExecutor(tree, decisionMaker, tracker);
      const result = await executor.execute('c1');

      expect(result.status).toBe('success');
      expect(result.finalNodeId).toBe('b1');
    });
  });

  describe('ToolCallNode', () => {
    it('executes tool handler and stores output', async () => {
      const tool = new ToolCallNode('t1', 'Fetch', {
        toolName: 'fetchData',
        parameters: { url: 'https://example.com' },
      });
      const success = new SuccessNode('s1', 'Done', { message: 'Fetched' });
      tree.addNode(tool);
      tree.addNode(success);
      tree.addEdge(makeEdge('e1', 't1', 's1'));

      const toolHandlers = new Map([
        [
          'fetchData',
          async (params: Record<string, unknown>) => ({
            data: 'result',
            url: params.url,
          }),
        ],
      ]);

      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        { toolHandlers },
      );
      const result = await executor.execute('t1');

      expect(result.status).toBe('success');
      expect(result.variables.tool_fetchData).toEqual({
        data: 'result',
        url: 'https://example.com',
      });
    });

    it('throws when no handler registered for tool', async () => {
      const tool = new ToolCallNode('t1', 'Unknown', {
        toolName: 'unknownTool',
        parameters: {},
      });
      const success = new SuccessNode('s1', 'Done', { message: 'Done' });
      tree.addNode(tool);
      tree.addNode(success);
      tree.addEdge(makeEdge('e1', 't1', 's1'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      const result = await executor.execute('t1');

      expect(result.status).toBe('error');
      expect(result.error).toContain('unknownTool');
    });

    it('asks LLM when tool node has multiple outgoing edges', async () => {
      const tool = new ToolCallNode('t1', 'Process', {
        toolName: 'process',
        parameters: {},
      });
      const sA = new SuccessNode('a1', 'Path A', { message: 'A' });
      const sB = new SuccessNode('b1', 'Path B', { message: 'B' });
      tree.addNode(tool);
      tree.addNode(sA);
      tree.addNode(sB);
      tree.addEdge(makeEdge('e1', 't1', 'a1'));
      tree.addEdge(makeEdge('e2', 't1', 'b1'));

      const toolHandlers = new Map([['process', async () => 'done']]);
      const decisionMaker = new MockDecisionMaker(['e2']);
      const executor = new TreeExecutor(tree, decisionMaker, tracker, {
        toolHandlers,
      });
      const result = await executor.execute('t1');

      expect(result.finalNodeId).toBe('b1');
    });
  });

  describe('events', () => {
    it('fires onStepStart and onComplete', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Hi' });
      const n2 = new SuccessNode('n2', 'End', { message: 'Done' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));

      const onStepStart = vi.fn();
      const onComplete = vi.fn();
      const events: ExecutionEvents = { onStepStart, onComplete };

      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        {},
        events,
      );
      await executor.execute('n1');

      expect(onStepStart).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0]?.[0].status).toBe('success');
    });

    it('fires onToolCall when tool executes', async () => {
      const tool = new ToolCallNode('t1', 'Tool', {
        toolName: 'myTool',
        parameters: {},
      });
      const success = new SuccessNode('s1', 'Done', { message: 'Done' });
      tree.addNode(tool);
      tree.addNode(success);
      tree.addEdge(makeEdge('e1', 't1', 's1'));

      const onToolCall = vi.fn();
      const toolHandlers = new Map([['myTool', async () => 42]]);
      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        { toolHandlers },
        { onToolCall },
      );
      await executor.execute('t1');

      expect(onToolCall).toHaveBeenCalledWith('t1', 'myTool', 42);
    });

    it('fires onConditionEvaluated', async () => {
      const cond = new ConditionalNode('c1', 'Check', {
        condition: 'test',
        evaluator: 'test',
      });
      const success = new SuccessNode('s1', 'Yes', { message: 'Yes' });
      tree.addNode(cond);
      tree.addNode(success);
      tree.addEdge(makeEdge('e-true', 'c1', 's1'));
      cond.trueEdgeId = 'e-true';

      const onConditionEvaluated = vi.fn();
      const evaluators = new Map([['test', () => true]]);
      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        { conditionEvaluators: evaluators },
        { onConditionEvaluated },
      );
      await executor.execute('c1');

      expect(onConditionEvaluated).toHaveBeenCalledWith('c1', 'test', true);
    });

    it('fires onError when execution fails', async () => {
      const n1 = new ConversationNode('n1', 'Dead end', { prompt: 'Hi' });
      tree.addNode(n1);
      // No outgoing edges and not terminal — will throw

      const onError = vi.fn();
      const executor = new TreeExecutor(
        tree,
        new MockDecisionMaker(),
        tracker,
        {},
        { onError },
      );
      const result = await executor.execute('n1');

      expect(result.status).toBe('error');
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe('path tracking', () => {
    it('records visits in the tracker', async () => {
      const n1 = new ConversationNode('n1', 'Start', { prompt: 'Hi' });
      const n2 = new SuccessNode('n2', 'End', { message: 'Done' });
      tree.addNode(n1);
      tree.addNode(n2);
      tree.addEdge(makeEdge('e1', 'n1', 'n2'));

      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      await executor.execute('n1');

      const sessions = tracker.getAllSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.length).toBe(2);
      expect(sessions[0]?.[0]?.nodeId).toBe('n1');
      expect(sessions[0]?.[1]?.nodeId).toBe('n2');
    });
  });

  describe('error handling', () => {
    it('throws on nonexistent start node', async () => {
      const executor = new TreeExecutor(tree, new MockDecisionMaker(), tracker);
      await expect(executor.execute('nonexistent')).rejects.toThrow(
        'does not exist',
      );
    });
  });
});
