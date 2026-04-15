import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface ToolCallNodeData {
  toolName: string;
  parameters: Record<string, unknown>;
  timeout?: number;
  retryCount?: number;
}

export class ToolCallNode implements INode {
  readonly type = 'tool_call';
  metadata: NodeMetadata;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: ToolCallNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
