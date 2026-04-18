import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge, INode, NodeMetadata, TreeMetadata } from '../core/interfaces.js';
import type { ConditionalNodeData } from '../nodes/ConditionalNode.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import type { ConversationNodeData } from '../nodes/ConversationNode.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import type { FailureNodeData } from '../nodes/FailureNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import type { SuccessNodeData } from '../nodes/SuccessNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import type { ToolCallNodeData } from '../nodes/ToolCallNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';

export interface SerializedNode {
  id: string;
  type: string;
  label: string;
  data: unknown;
  metadata: NodeMetadata;
  trueEdgeId?: string;
  falseEdgeId?: string;
}

export interface SerializedTree {
  version: 1 | 2;
  metadata?: TreeMetadata;
  nodes: SerializedNode[];
  edges: IEdge[];
}

export type NodeFactory = (serialized: SerializedNode) => INode;

export class TreeSerializer {
  private factories = new Map<string, NodeFactory>();

  constructor() {
    this.registerBuiltinTypes();
  }

  private registerBuiltinTypes(): void {
    this.factories.set(
      'conversation',
      (s) =>
        new ConversationNode(
          s.id,
          s.label,
          s.data as ConversationNodeData,
          s.metadata,
        ),
    );

    this.factories.set(
      'tool_call',
      (s) =>
        new ToolCallNode(s.id, s.label, s.data as ToolCallNodeData, s.metadata),
    );

    this.factories.set('conditional', (s) => {
      const node = new ConditionalNode(
        s.id,
        s.label,
        s.data as ConditionalNodeData,
        s.metadata,
      );
      if (s.trueEdgeId !== undefined) node.trueEdgeId = s.trueEdgeId;
      if (s.falseEdgeId !== undefined) node.falseEdgeId = s.falseEdgeId;
      return node;
    });

    this.factories.set(
      'success',
      (s) =>
        new SuccessNode(s.id, s.label, s.data as SuccessNodeData, s.metadata),
    );

    this.factories.set(
      'failure',
      (s) =>
        new FailureNode(s.id, s.label, s.data as FailureNodeData, s.metadata),
    );
  }

  registerNodeType(type: string, factory: NodeFactory): void {
    this.factories.set(type, factory);
  }

  serialize(tree: DecisionTree): SerializedTree {
    const nodes: SerializedNode[] = tree.getAllNodes().map((node) => {
      const serialized: SerializedNode = {
        id: node.id,
        type: node.type,
        label: node.label,
        data: (node as { data?: unknown }).data ?? {},
        metadata: node.metadata,
      };

      // Preserve ConditionalNode edge references
      const conditional = node as { trueEdgeId?: string; falseEdgeId?: string };
      if (conditional.trueEdgeId !== undefined) {
        serialized.trueEdgeId = conditional.trueEdgeId;
      }
      if (conditional.falseEdgeId !== undefined) {
        serialized.falseEdgeId = conditional.falseEdgeId;
      }

      return serialized;
    });

    return {
      version: 2,
      metadata: tree.metadata,
      nodes,
      edges: tree.getAllEdges(),
    };
  }

  deserialize(data: SerializedTree): DecisionTree {
    const tree = new DecisionTree();

    // Restore metadata (v2+); v1 files have no metadata field
    if (data.metadata) {
      tree.metadata = data.metadata;
    }

    for (const serializedNode of data.nodes) {
      const factory = this.factories.get(serializedNode.type);
      if (!factory) {
        throw new Error(
          `Unknown node type "${serializedNode.type}". Register it with registerNodeType().`,
        );
      }
      const node = factory(serializedNode);
      tree.addNode(node);
    }

    for (const edge of data.edges) {
      tree.addEdge(edge);
    }

    return tree;
  }

  toJSON(tree: DecisionTree): string {
    return JSON.stringify(this.serialize(tree), null, 2);
  }

  fromJSON(json: string): DecisionTree {
    return this.deserialize(JSON.parse(json) as SerializedTree);
  }
}
