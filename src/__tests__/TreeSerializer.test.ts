import { describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge, INode, NodeMetadata } from '../core/interfaces.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';
import type { SerializedNode } from '../serialization/TreeSerializer.js';
import { TreeSerializer } from '../serialization/TreeSerializer.js';

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  condition?: string,
  weight?: number,
): IEdge {
  return { id, sourceId, targetId, metadata: {}, condition, weight };
}

describe('TreeSerializer', () => {
  describe('round-trip serialization', () => {
    it('round-trips ConversationNode', () => {
      const tree = new DecisionTree();
      const node = new ConversationNode(
        'c1',
        'Ask',
        {
          prompt: 'What next?',
          expectedResponses: ['yes', 'no'],
          systemMessage: 'Be helpful',
        },
        { priority: 1 },
      );
      const end = new SuccessNode('s1', 'Done', { message: 'OK' });
      tree.addNode(node);
      tree.addNode(end);
      tree.addEdge(makeEdge('e1', 'c1', 's1'));

      const serializer = new TreeSerializer();
      const json = serializer.toJSON(tree);
      const restored = serializer.fromJSON(json);

      const restoredNode = restored.getNode('c1') as ConversationNode;
      expect(restoredNode).toBeDefined();
      expect(restoredNode.type).toBe('conversation');
      expect(restoredNode.label).toBe('Ask');
      expect(restoredNode.data.prompt).toBe('What next?');
      expect(restoredNode.data.expectedResponses).toEqual(['yes', 'no']);
      expect(restoredNode.data.systemMessage).toBe('Be helpful');
      expect(restoredNode.metadata).toEqual({ priority: 1 });
    });

    it('round-trips ToolCallNode', () => {
      const tree = new DecisionTree();
      const node = new ToolCallNode('t1', 'Fetch', {
        toolName: 'httpGet',
        parameters: { url: 'https://api.example.com' },
        timeout: 5000,
        retryCount: 3,
      });
      const end = new SuccessNode('s1', 'Done', { message: 'OK' });
      tree.addNode(node);
      tree.addNode(end);
      tree.addEdge(makeEdge('e1', 't1', 's1'));

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const restoredNode = restored.getNode('t1') as ToolCallNode;
      expect(restoredNode.type).toBe('tool_call');
      expect(restoredNode.data.toolName).toBe('httpGet');
      expect(restoredNode.data.parameters).toEqual({
        url: 'https://api.example.com',
      });
      expect(restoredNode.data.timeout).toBe(5000);
      expect(restoredNode.data.retryCount).toBe(3);
    });

    it('round-trips ConditionalNode with trueEdgeId/falseEdgeId', () => {
      const tree = new DecisionTree();
      const cond = new ConditionalNode('cond1', 'Check', {
        condition: 'x > 5',
        evaluator: 'numCheck',
      });
      cond.trueEdgeId = 'e-yes';
      cond.falseEdgeId = 'e-no';

      const yes = new SuccessNode('y1', 'Yes', { message: 'Yes' });
      const no = new FailureNode('n1', 'No', {
        message: 'No',
        recoverable: false,
      });
      tree.addNode(cond);
      tree.addNode(yes);
      tree.addNode(no);
      tree.addEdge(makeEdge('e-yes', 'cond1', 'y1'));
      tree.addEdge(makeEdge('e-no', 'cond1', 'n1'));

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const restoredCond = restored.getNode('cond1') as ConditionalNode;
      expect(restoredCond.type).toBe('conditional');
      expect(restoredCond.data.condition).toBe('x > 5');
      expect(restoredCond.data.evaluator).toBe('numCheck');
      expect(restoredCond.trueEdgeId).toBe('e-yes');
      expect(restoredCond.falseEdgeId).toBe('e-no');
    });

    it('round-trips SuccessNode', () => {
      const tree = new DecisionTree();
      const node = new SuccessNode('s1', 'Win', {
        message: 'You win!',
        resultData: { score: 100 },
      });
      tree.addNode(node);

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const restoredNode = restored.getNode('s1') as SuccessNode;
      expect(restoredNode.type).toBe('success');
      expect(restoredNode.data.message).toBe('You win!');
      expect(restoredNode.data.resultData).toEqual({ score: 100 });
    });

    it('round-trips FailureNode', () => {
      const tree = new DecisionTree();
      const node = new FailureNode('f1', 'Fail', {
        message: 'Something broke',
        errorCode: 'E001',
        recoverable: true,
        suggestedAction: 'Retry',
      });
      tree.addNode(node);

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const restoredNode = restored.getNode('f1') as FailureNode;
      expect(restoredNode.type).toBe('failure');
      expect(restoredNode.data.message).toBe('Something broke');
      expect(restoredNode.data.errorCode).toBe('E001');
      expect(restoredNode.data.recoverable).toBe(true);
      expect(restoredNode.data.suggestedAction).toBe('Retry');
    });
  });

  describe('edge preservation', () => {
    it('preserves edge conditions and weights', () => {
      const tree = new DecisionTree();
      tree.addNode(new ConversationNode('n1', 'Start', { prompt: 'Go' }));
      tree.addNode(new SuccessNode('n2', 'A', { message: 'A' }));
      tree.addNode(new SuccessNode('n3', 'B', { message: 'B' }));
      tree.addEdge(makeEdge('e1', 'n1', 'n2', 'is true', 0.8));
      tree.addEdge(makeEdge('e2', 'n1', 'n3', 'is false', 0.2));

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const e1 = restored.getEdge('e1');
      expect(e1).toBeDefined();
      expect(e1?.condition).toBe('is true');
      expect(e1?.weight).toBe(0.8);

      const e2 = restored.getEdge('e2');
      expect(e2?.condition).toBe('is false');
      expect(e2?.weight).toBe(0.2);
    });

    it('preserves edge metadata', () => {
      const tree = new DecisionTree();
      tree.addNode(new ConversationNode('n1', 'A', { prompt: 'A' }));
      tree.addNode(new SuccessNode('n2', 'B', { message: 'B' }));
      const edge: IEdge = {
        id: 'e1',
        sourceId: 'n1',
        targetId: 'n2',
        metadata: { custom: 'data', count: 42 },
      };
      tree.addEdge(edge);

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      const restoredEdge = restored.getEdge('e1');
      expect(restoredEdge?.metadata).toEqual({ custom: 'data', count: 42 });
    });
  });

  describe('full tree with all node types', () => {
    it('round-trips a complete tree', () => {
      const tree = new DecisionTree();
      tree.addNode(new ConversationNode('c1', 'Start', { prompt: 'Begin' }));
      tree.addNode(
        new ToolCallNode('t1', 'Fetch', { toolName: 'get', parameters: {} }),
      );
      const cond = new ConditionalNode('cond1', 'Check', { condition: 'ok' });
      cond.trueEdgeId = 'e3';
      cond.falseEdgeId = 'e4';
      tree.addNode(cond);
      tree.addNode(new SuccessNode('s1', 'Done', { message: 'OK' }));
      tree.addNode(
        new FailureNode('f1', 'Error', { message: 'Fail', recoverable: false }),
      );

      tree.addEdge(makeEdge('e1', 'c1', 't1'));
      tree.addEdge(makeEdge('e2', 't1', 'cond1'));
      tree.addEdge(makeEdge('e3', 'cond1', 's1'));
      tree.addEdge(makeEdge('e4', 'cond1', 'f1'));

      const serializer = new TreeSerializer();
      const restored = serializer.fromJSON(serializer.toJSON(tree));

      expect(restored.nodeCount).toBe(5);
      expect(restored.edgeCount).toBe(4);
      expect(restored.getNode('c1')?.type).toBe('conversation');
      expect(restored.getNode('t1')?.type).toBe('tool_call');
      expect(restored.getNode('cond1')?.type).toBe('conditional');
      expect(restored.getNode('s1')?.type).toBe('success');
      expect(restored.getNode('f1')?.type).toBe('failure');
    });
  });

  describe('custom node types', () => {
    it('registers and deserializes custom node types', () => {
      class CustomNode implements INode {
        readonly type = 'custom';
        metadata: NodeMetadata;
        constructor(
          public readonly id: string,
          public readonly label: string,
          public readonly data: { value: number },
          metadata?: NodeMetadata,
        ) {
          this.metadata = metadata ?? {};
        }
      }

      const tree = new DecisionTree();
      tree.addNode(new CustomNode('x1', 'Custom', { value: 42 }));

      const serializer = new TreeSerializer();
      serializer.registerNodeType('custom', (s: SerializedNode) => {
        return new CustomNode(
          s.id,
          s.label,
          s.data as { value: number },
          s.metadata,
        );
      });

      const restored = serializer.fromJSON(serializer.toJSON(tree));
      const node = restored.getNode('x1') as CustomNode;
      expect(node.type).toBe('custom');
      expect(node.data.value).toBe(42);
    });

    it('throws on unknown node type', () => {
      const serializer = new TreeSerializer();
      const badData = {
        version: 1 as const,
        nodes: [{ id: 'x', type: 'alien', label: 'X', data: {}, metadata: {} }],
        edges: [],
      };

      expect(() => serializer.deserialize(badData)).toThrow(
        'Unknown node type "alien"',
      );
    });
  });

  describe('JSON methods', () => {
    it('toJSON returns valid JSON string', () => {
      const tree = new DecisionTree();
      tree.addNode(new SuccessNode('s1', 'Done', { message: 'OK' }));

      const serializer = new TreeSerializer();
      const json = serializer.toJSON(tree);

      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed.version).toBe(2);
      expect(parsed.nodes).toHaveLength(1);
    });

    it('fromJSON restores from JSON string', () => {
      const json = JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 's1',
            type: 'success',
            label: 'Done',
            data: { message: 'OK' },
            metadata: {},
          },
        ],
        edges: [],
      });

      const serializer = new TreeSerializer();
      const tree = serializer.fromJSON(json);
      expect(tree.nodeCount).toBe(1);
      expect(tree.getNode('s1')?.label).toBe('Done');
    });
  });
});
