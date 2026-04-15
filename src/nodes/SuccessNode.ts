import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface SuccessNodeData {
  message: string; // Success message/description
  resultData?: unknown; // Optional result payload
}

export class SuccessNode implements INode {
  readonly type = 'success';
  metadata: NodeMetadata;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: SuccessNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
