import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface FailureNodeData {
  message: string; // Failure message/description
  errorCode?: string; // Optional error code
  recoverable: boolean; // Whether recovery is possible
  suggestedAction?: string; // What to do on failure
}

export class FailureNode implements INode {
  readonly type = 'failure';
  metadata: NodeMetadata;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: FailureNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
