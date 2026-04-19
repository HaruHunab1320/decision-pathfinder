import { describe, expect, it } from 'vitest';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IEdge } from '../core/interfaces.js';
import { MockDecisionMaker, TreeExecutor } from '../execution/TreeExecutor.js';
import type { TreeResolver } from '../execution/TreeExecutor.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { SubTreeNode } from '../nodes/SubTreeNode.js';
import { PathTracker } from '../tracking/PathTracker.js';

function edge(id: string, sourceId: string, targetId: string): IEdge {
  return { id, sourceId, targetId, metadata: {} };
}

describe('SubTreeNode execution', () => {
  it('executes a sub-tree and continues in the parent', async () => {
    // Sub-tree: simple success
    const subTree = new DecisionTree();
    subTree.addNode(
      new ConversationNode('sub-start', 'Sub Start', { prompt: 'do sub-task' }),
    );
    subTree.addNode(
      new SuccessNode('sub-done', 'Sub Done', { message: 'sub ok' }),
    );
    subTree.addEdge(edge('se1', 'sub-start', 'sub-done'));

    const subTracker = new PathTracker();
    const resolver: TreeResolver = async (treeId) => {
      if (treeId === 'sub-task') {
        return { tree: subTree, tracker: subTracker };
      }
      return null;
    };

    // Parent tree: start → sub-tree → done
    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'begin' }),
    );
    parent.addNode(
      new SubTreeNode('run-sub', 'Run Sub-Task', { treeId: 'sub-task' }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'parent ok' }),
    );
    parent.addEdge(edge('e1', 'start', 'run-sub'));
    parent.addEdge(edge('e2', 'run-sub', 'done'));

    const tracker = new PathTracker();
    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      tracker,
      { treeResolver: resolver },
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('success');
    expect(result.pathTaken).toEqual(['start', 'run-sub', 'done']);
  });

  it('merges sub-tree variables into parent context', async () => {
    const subTree = new DecisionTree();
    subTree.addNode(
      new ConversationNode('sub-start', 'Sub Start', { prompt: 'do it' }),
    );
    subTree.addNode(
      new SuccessNode('sub-done', 'Sub Done', { message: 'computed' }),
    );
    subTree.addEdge(edge('se1', 'sub-start', 'sub-done'));

    const resolver: TreeResolver = async (treeId) => {
      if (treeId === 'compute') {
        return { tree: subTree, tracker: new PathTracker() };
      }
      return null;
    };

    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    parent.addNode(
      new SubTreeNode('compute', 'Compute', { treeId: 'compute' }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'ok' }),
    );
    parent.addEdge(edge('e1', 'start', 'compute'));
    parent.addEdge(edge('e2', 'compute', 'done'));

    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      new PathTracker(),
      { treeResolver: resolver },
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('success');
    // Sub-tree result should be merged into variables
    expect(result.variables['subtree_compute']).toBeDefined();
    const subResult = result.variables['subtree_compute'] as {
      status: string;
    };
    expect(subResult.status).toBe('success');
  });

  it('propagates sub-tree failure as an error', async () => {
    const subTree = new DecisionTree();
    subTree.addNode(
      new ConversationNode('sub-start', 'Sub Start', { prompt: 'fail' }),
    );
    subTree.addNode(
      new FailureNode('sub-fail', 'Sub Fail', {
        message: 'sub broke',
        recoverable: false,
      }),
    );
    subTree.addEdge(edge('se1', 'sub-start', 'sub-fail'));

    const resolver: TreeResolver = async (treeId) => {
      if (treeId === 'failing-task') {
        return { tree: subTree, tracker: new PathTracker() };
      }
      return null;
    };

    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    parent.addNode(
      new SubTreeNode('run-fail', 'Run Failing', {
        treeId: 'failing-task',
      }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'ok' }),
    );
    parent.addEdge(edge('e1', 'start', 'run-fail'));
    parent.addEdge(edge('e2', 'run-fail', 'done'));

    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      new PathTracker(),
      { treeResolver: resolver },
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('error');
    expect(result.error).toContain('failing-task');
  });

  it('throws when treeResolver is not configured', async () => {
    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    parent.addNode(
      new SubTreeNode('run-sub', 'Run Sub', { treeId: 'some-tree' }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'ok' }),
    );
    parent.addEdge(edge('e1', 'start', 'run-sub'));
    parent.addEdge(edge('e2', 'run-sub', 'done'));

    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      new PathTracker(),
      // no treeResolver
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('error');
    expect(result.error).toContain('treeResolver');
  });

  it('throws when sub-tree is not found', async () => {
    const resolver: TreeResolver = async () => null;

    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    parent.addNode(
      new SubTreeNode('run-sub', 'Run Sub', { treeId: 'missing-tree' }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'ok' }),
    );
    parent.addEdge(edge('e1', 'start', 'run-sub'));
    parent.addEdge(edge('e2', 'run-sub', 'done'));

    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      new PathTracker(),
      { treeResolver: resolver },
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('error');
    expect(result.error).toContain('missing-tree');
  });

  it('supports nested sub-trees (sub-tree within sub-tree)', async () => {
    // Inner sub-tree
    const inner = new DecisionTree();
    inner.addNode(
      new ConversationNode('inner-start', 'Inner', { prompt: 'inner' }),
    );
    inner.addNode(
      new SuccessNode('inner-done', 'Inner Done', { message: 'inner ok' }),
    );
    inner.addEdge(edge('ie1', 'inner-start', 'inner-done'));

    // Outer sub-tree (contains a SubTreeNode referencing inner)
    const outer = new DecisionTree();
    outer.addNode(
      new ConversationNode('outer-start', 'Outer', { prompt: 'outer' }),
    );
    outer.addNode(
      new SubTreeNode('call-inner', 'Call Inner', { treeId: 'inner' }),
    );
    outer.addNode(
      new SuccessNode('outer-done', 'Outer Done', { message: 'outer ok' }),
    );
    outer.addEdge(edge('oe1', 'outer-start', 'call-inner'));
    outer.addEdge(edge('oe2', 'call-inner', 'outer-done'));

    const resolver: TreeResolver = async (treeId) => {
      if (treeId === 'inner') return { tree: inner, tracker: new PathTracker() };
      if (treeId === 'outer') return { tree: outer, tracker: new PathTracker() };
      return null;
    };

    // Parent
    const parent = new DecisionTree();
    parent.addNode(
      new ConversationNode('start', 'Start', { prompt: 'go' }),
    );
    parent.addNode(
      new SubTreeNode('call-outer', 'Call Outer', { treeId: 'outer' }),
    );
    parent.addNode(
      new SuccessNode('done', 'Done', { message: 'all ok' }),
    );
    parent.addEdge(edge('pe1', 'start', 'call-outer'));
    parent.addEdge(edge('pe2', 'call-outer', 'done'));

    const executor = new TreeExecutor(
      parent,
      new MockDecisionMaker(),
      new PathTracker(),
      { treeResolver: resolver },
    );

    const result = await executor.execute('start');
    expect(result.status).toBe('success');
    expect(result.pathTaken).toEqual(['start', 'call-outer', 'done']);

    // Verify nested variable merging
    const outerVars = result.variables['subtree_outer'] as {
      variables: Record<string, unknown>;
    };
    expect(outerVars.variables['subtree_inner']).toBeDefined();
  });
});
