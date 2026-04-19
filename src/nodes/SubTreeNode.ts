import type { INode, NodeId, NodeMetadata } from '../core/interfaces.js';

export interface SubTreeNodeData {
  /** ID of the tree to execute (must be loaded or loadable). */
  treeId: string;
  /** Node ID to start execution from. Defaults to the sub-tree's root. */
  startNodeId?: string;
  /** Variables to pass into the sub-tree's execution context. */
  inputVariables?: Record<string, unknown>;
  /** Max steps for the sub-tree execution. Default: 50. */
  maxSteps?: number;
}

/**
 * A node that delegates to another decision tree.
 *
 * When the executor reaches a SubTreeNode, it executes the referenced tree
 * as a nested call. The sub-tree's result (success/failure) and variables
 * are merged back into the parent context. If the sub-tree succeeds, the
 * executor follows the outgoing edge; if it fails, it records the failure.
 *
 * This enables tree composition — breaking large workflows into reusable
 * sub-trees that can be developed and tested independently.
 */
export class SubTreeNode implements INode {
  readonly type = 'sub_tree';
  metadata: NodeMetadata;

  constructor(
    public readonly id: NodeId,
    public readonly label: string,
    public readonly data: SubTreeNodeData,
    metadata?: NodeMetadata,
  ) {
    this.metadata = metadata ?? {};
  }
}
