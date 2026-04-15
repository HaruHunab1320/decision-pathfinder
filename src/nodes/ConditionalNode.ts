import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface ConditionalNodeData {
  condition: string;
  evaluator?: string;
}

export class ConditionalNode implements INode {
  readonly type = 'conditional';
  metadata: NodeMetadata;

  trueEdgeId?: string;
  falseEdgeId?: string;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: ConditionalNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
