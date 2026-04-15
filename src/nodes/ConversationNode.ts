import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface ConversationNodeData {
  prompt: string;
  expectedResponses?: string[];
  systemMessage?: string;
}

export class ConversationNode implements INode {
  readonly type = 'conversation';
  metadata: NodeMetadata;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: ConversationNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
