import { describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge, INode } from '../core/interfaces.js';
import { ExecutionStream } from '../execution/ExecutionStream.js';
import type { ExecutionEvent } from '../execution/ExecutionStream.js';
import { MockDecisionMaker } from '../execution/TreeExecutor.js';
import { PathTracker } from '../tracking/PathTracker.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';

function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}

describe('ExecutionStream', () => {
  it('yields step_start and complete events for a simple path', async () => {
    const tree = new DecisionTree();
    tree.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    tree.addNode(new SuccessNode('done', 'Done', { message: 'ok' }));
    tree.addEdge(edge('e1', 'start', 'done'));

    const tracker = new PathTracker();
    const stream = new ExecutionStream(
      tree,
      new MockDecisionMaker(),
      tracker,
    );

    const events: ExecutionEvent[] = [];
    for await (const event of stream.execute('start')) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('step_start');
    expect(types).toContain('complete');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'complete') {
      expect(complete.result.status).toBe('success');
      expect(complete.result.pathTaken).toEqual(['start', 'done']);
    }
  });

  it('yields tool_call events for ToolCallNodes', async () => {
    const tree = new DecisionTree();
    tree.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    tree.addNode(
      new ToolCallNode('fetch', 'Fetch', {
        toolName: 'fetchData',
        parameters: {},
      }),
    );
    tree.addNode(new SuccessNode('done', 'Done', { message: 'ok' }));
    tree.addEdge(edge('e1', 'start', 'fetch'));
    tree.addEdge(edge('e2', 'fetch', 'done'));

    const tracker = new PathTracker();
    const stream = new ExecutionStream(
      tree,
      new MockDecisionMaker(),
      tracker,
      {
        toolHandlers: new Map([
          ['fetchData', async () => ({ data: 'result' })],
        ]),
      },
    );

    const events: ExecutionEvent[] = [];
    for await (const event of stream.execute('start')) {
      events.push(event);
    }

    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    if (toolEvents[0]?.type === 'tool_call') {
      expect(toolEvents[0].toolName).toBe('fetchData');
    }
  });

  it('yields complete with failure status for failure terminals', async () => {
    const tree = new DecisionTree();
    tree.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    tree.addNode(
      new FailureNode('fail', 'Failed', {
        message: 'bad',
        recoverable: false,
      }),
    );
    tree.addEdge(edge('e1', 'start', 'fail'));

    const tracker = new PathTracker();
    const stream = new ExecutionStream(
      tree,
      new MockDecisionMaker(),
      tracker,
    );

    const events: ExecutionEvent[] = [];
    for await (const event of stream.execute('start')) {
      events.push(event);
    }

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'complete') {
      expect(complete.result.status).toBe('failure');
    }
  });

  it('yields step_complete events with chosen edge IDs', async () => {
    const tree = new DecisionTree();
    tree.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    tree.addNode(
      new ConversationNode('mid', 'Middle', { prompt: 'continue' }),
    );
    tree.addNode(new SuccessNode('done', 'Done', { message: 'ok' }));
    tree.addEdge(edge('e1', 'start', 'mid'));
    tree.addEdge(edge('e2', 'mid', 'done'));

    const tracker = new PathTracker();
    const stream = new ExecutionStream(
      tree,
      new MockDecisionMaker(),
      tracker,
    );

    const events: ExecutionEvent[] = [];
    for await (const event of stream.execute('start')) {
      events.push(event);
    }

    const stepCompletes = events.filter((e) => e.type === 'step_complete');
    expect(stepCompletes.length).toBeGreaterThan(0);
    if (stepCompletes[0]?.type === 'step_complete') {
      expect(stepCompletes[0].chosenEdgeId).toBe('e1');
    }
  });

  it('collects all events in order', async () => {
    const tree = new DecisionTree();
    tree.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    tree.addNode(new SuccessNode('done', 'Done', { message: 'ok' }));
    tree.addEdge(edge('e1', 'start', 'done'));

    const tracker = new PathTracker();
    const stream = new ExecutionStream(
      tree,
      new MockDecisionMaker(),
      tracker,
    );

    const events: ExecutionEvent[] = [];
    for await (const event of stream.execute('start')) {
      events.push(event);
    }

    // Last event should always be 'complete'
    expect(events[events.length - 1]!.type).toBe('complete');
  });
});
