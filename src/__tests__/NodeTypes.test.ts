import { describe, expect, it } from 'vitest';
import type { INode } from '../core/interfaces.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';

describe('NodeTypes', () => {
  describe('ConversationNode', () => {
    it('creates with required properties', () => {
      const node = new ConversationNode('c1', 'Greeting', {
        prompt: 'Hello, how can I help?',
      });
      expect(node.id).toBe('c1');
      expect(node.label).toBe('Greeting');
      expect(node.type).toBe('conversation');
      expect(node.data.prompt).toBe('Hello, how can I help?');
    });

    it('stores optional data fields', () => {
      const node = new ConversationNode('c2', 'Ask', {
        prompt: 'Pick one',
        expectedResponses: ['yes', 'no'],
        systemMessage: 'Be concise',
      });
      expect(node.data.expectedResponses).toEqual(['yes', 'no']);
      expect(node.data.systemMessage).toBe('Be concise');
    });

    it('defaults metadata to empty object', () => {
      const node = new ConversationNode('c3', 'Test', { prompt: 'p' });
      expect(node.metadata).toEqual({});
    });

    it('accepts custom metadata', () => {
      const node = new ConversationNode(
        'c4',
        'Test',
        { prompt: 'p' },
        { priority: 1 },
      );
      expect(node.metadata).toEqual({ priority: 1 });
    });
  });

  describe('ToolCallNode', () => {
    it('creates with required properties', () => {
      const node = new ToolCallNode('t1', 'Search', {
        toolName: 'web_search',
        parameters: { query: 'test' },
      });
      expect(node.id).toBe('t1');
      expect(node.label).toBe('Search');
      expect(node.type).toBe('tool_call');
      expect(node.data.toolName).toBe('web_search');
      expect(node.data.parameters).toEqual({ query: 'test' });
    });

    it('stores optional timeout and retryCount', () => {
      const node = new ToolCallNode('t2', 'Fetch', {
        toolName: 'http_get',
        parameters: {},
        timeout: 5000,
        retryCount: 3,
      });
      expect(node.data.timeout).toBe(5000);
      expect(node.data.retryCount).toBe(3);
    });

    it('defaults metadata to empty object', () => {
      const node = new ToolCallNode('t3', 'X', {
        toolName: 'x',
        parameters: {},
      });
      expect(node.metadata).toEqual({});
    });
  });

  describe('ConditionalNode', () => {
    it('creates with required properties', () => {
      const node = new ConditionalNode('cond1', 'Check age', {
        condition: 'age >= 18',
      });
      expect(node.id).toBe('cond1');
      expect(node.label).toBe('Check age');
      expect(node.type).toBe('conditional');
      expect(node.data.condition).toBe('age >= 18');
    });

    it('supports trueEdgeId and falseEdgeId', () => {
      const node = new ConditionalNode('cond2', 'Branch', {
        condition: 'x > 0',
      });
      node.trueEdgeId = 'edge-true';
      node.falseEdgeId = 'edge-false';
      expect(node.trueEdgeId).toBe('edge-true');
      expect(node.falseEdgeId).toBe('edge-false');
    });

    it('trueEdgeId and falseEdgeId default to undefined', () => {
      const node = new ConditionalNode('cond3', 'X', { condition: 'c' });
      expect(node.trueEdgeId).toBeUndefined();
      expect(node.falseEdgeId).toBeUndefined();
    });

    it('defaults metadata to empty object', () => {
      const node = new ConditionalNode('cond4', 'X', { condition: 'c' });
      expect(node.metadata).toEqual({});
    });
  });

  describe('SuccessNode', () => {
    it('creates with required properties', () => {
      const node = new SuccessNode('s1', 'Done', {
        message: 'Task completed successfully',
      });
      expect(node.id).toBe('s1');
      expect(node.label).toBe('Done');
      expect(node.type).toBe('success');
      expect(node.data.message).toBe('Task completed successfully');
    });

    it('stores optional resultData', () => {
      const node = new SuccessNode('s2', 'Done', {
        message: 'OK',
        resultData: { count: 42 },
      });
      expect(node.data.resultData).toEqual({ count: 42 });
    });

    it('defaults metadata to empty object', () => {
      const node = new SuccessNode('s3', 'X', { message: 'm' });
      expect(node.metadata).toEqual({});
    });
  });

  describe('FailureNode', () => {
    it('creates with required properties', () => {
      const node = new FailureNode('f1', 'Error', {
        message: 'Something went wrong',
        recoverable: false,
      });
      expect(node.id).toBe('f1');
      expect(node.label).toBe('Error');
      expect(node.type).toBe('failure');
      expect(node.data.message).toBe('Something went wrong');
      expect(node.data.recoverable).toBe(false);
    });

    it('stores optional errorCode and suggestedAction', () => {
      const node = new FailureNode('f2', 'Fail', {
        message: 'Timeout',
        recoverable: true,
        errorCode: 'E_TIMEOUT',
        suggestedAction: 'Retry after 5s',
      });
      expect(node.data.errorCode).toBe('E_TIMEOUT');
      expect(node.data.suggestedAction).toBe('Retry after 5s');
    });

    it('defaults metadata to empty object', () => {
      const node = new FailureNode('f3', 'X', {
        message: 'm',
        recoverable: true,
      });
      expect(node.metadata).toEqual({});
    });
  });

  describe('INode interface compliance', () => {
    it('all node types satisfy INode with id, type, label, metadata', () => {
      const nodes: INode[] = [
        new ConversationNode('a', 'A', { prompt: 'p' }),
        new ToolCallNode('b', 'B', { toolName: 't', parameters: {} }),
        new ConditionalNode('c', 'C', { condition: 'c' }),
        new SuccessNode('d', 'D', { message: 'm' }),
        new FailureNode('e', 'E', { message: 'm', recoverable: false }),
      ];

      for (const node of nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('type');
        expect(node).toHaveProperty('label');
        expect(node).toHaveProperty('metadata');
        expect(typeof node.id).toBe('string');
        expect(typeof node.type).toBe('string');
        expect(typeof node.label).toBe('string');
        expect(typeof node.metadata).toBe('object');
      }
    });
  });
});
