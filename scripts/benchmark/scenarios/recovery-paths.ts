/**
 * Scenario 6: Recovery Paths
 *
 * Primary path is blocked (100% failure on first tool). Recovery branch
 * has a tool with 30% failure, requiring a second fallback. Success requires
 * navigating 2 levels of recovery.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { ConditionalNode } from '../../../src/nodes/ConditionalNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { createSafeToolHandler, createStaticTool } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildRecoveryPaths(): ScenarioDefinition {
  const tree = new DecisionTree();

  // Choose path
  tree.addNode(new ConversationNode('start', 'Choose Service Endpoint', {
    prompt: 'Select a service endpoint to process the request. The primary endpoint is the default choice. The backup endpoint is available if primary is down. The manual fallback requires more steps but always works.',
  }));

  // ── Primary path (always fails — simulating outage) ──
  tree.addNode(new ToolCallNode('primary', 'Call Primary Service', {
    toolName: 'primaryService', parameters: {},
  }));
  const pCheck = new ConditionalNode('p-check', 'Check Primary', {
    condition: 'primaryServiceSuccess', evaluator: 'primaryServiceSuccess',
  });
  pCheck.trueEdgeId = 'e-p-ok';
  pCheck.falseEdgeId = 'e-p-fail';
  tree.addNode(pCheck);

  // ── Backup path (30% failure) ──
  tree.addNode(new ToolCallNode('backup', 'Call Backup Service', {
    toolName: 'backupService', parameters: {},
  }));
  const bCheck = new ConditionalNode('b-check', 'Check Backup', {
    condition: 'backupServiceSuccess', evaluator: 'backupServiceSuccess',
  });
  bCheck.trueEdgeId = 'e-b-ok';
  bCheck.falseEdgeId = 'e-b-fail';
  tree.addNode(bCheck);

  // ── Manual fallback (always succeeds, but longer) ──
  tree.addNode(new ToolCallNode('manual-1', 'Manual Step 1: Prepare', {
    toolName: 'manualPrepare', parameters: {},
  }));
  tree.addNode(new ToolCallNode('manual-2', 'Manual Step 2: Execute', {
    toolName: 'manualExecute', parameters: {},
  }));

  // Terminal
  tree.addNode(new SuccessNode('done', 'Request Processed', { message: 'Request processed successfully' }));
  tree.addNode(new FailureNode('all-failed', 'All Paths Failed', {
    message: 'Primary and backup both failed with no recovery',
    recoverable: false,
  }));

  // ── Edges ──
  tree.addEdge({ id: 'e-start-primary', sourceId: 'start', targetId: 'primary', condition: 'Use primary endpoint (default)', metadata: {} });
  tree.addEdge({ id: 'e-start-backup', sourceId: 'start', targetId: 'backup', condition: 'Use backup endpoint (if primary is down)', metadata: {} });
  tree.addEdge({ id: 'e-start-manual', sourceId: 'start', targetId: 'manual-1', condition: 'Use manual fallback (always works, slower)', metadata: {} });

  tree.addEdge({ id: 'e-p-to-check', sourceId: 'primary', targetId: 'p-check', metadata: {} });
  tree.addEdge({ id: 'e-p-ok', sourceId: 'p-check', targetId: 'done', metadata: {} });
  tree.addEdge({ id: 'e-p-fail', sourceId: 'p-check', targetId: 'all-failed', metadata: {} });

  tree.addEdge({ id: 'e-b-to-check', sourceId: 'backup', targetId: 'b-check', metadata: {} });
  tree.addEdge({ id: 'e-b-ok', sourceId: 'b-check', targetId: 'done', metadata: {} });
  tree.addEdge({ id: 'e-b-fail', sourceId: 'b-check', targetId: 'all-failed', metadata: {} });

  tree.addEdge({ id: 'e-m1-m2', sourceId: 'manual-1', targetId: 'manual-2', metadata: {} });
  tree.addEdge({ id: 'e-m2-done', sourceId: 'manual-2', targetId: 'done', metadata: {} });

  // ── Tools ──
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();
  toolHandlers.set('primaryService', createSafeToolHandler({
    name: 'primaryService', failureRate: 1.0, latencyMs: 10, latencyJitterMs: 5,
    outputs: [{ ok: true }],
    failureError: 'Primary service: 503 Service Unavailable',
  }));
  toolHandlers.set('backupService', createSafeToolHandler({
    name: 'backupService', failureRate: 0.3, latencyMs: 15, latencyJitterMs: 5,
    outputs: [{ ok: true, source: 'backup' }],
    failureError: 'Backup service: connection reset',
  }));
  toolHandlers.set('manualPrepare', createStaticTool({ prepared: true }));
  toolHandlers.set('manualExecute', createStaticTool({ executed: true, source: 'manual' }));

  // ── Conditions ──
  const evals = new Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>();
  evals.set('primaryServiceSuccess', (ctx) => {
    const r = ctx.variables['tool_primaryService'] as { success?: boolean } | undefined;
    return r?.success === true;
  });
  evals.set('backupServiceSuccess', (ctx) => {
    const r = ctx.variables['tool_backupService'] as { success?: boolean } | undefined;
    return r?.success === true;
  });

  return {
    name: 'Recovery Paths',
    description: 'Primary endpoint always fails (outage). Backup has 30% failure. Manual fallback always works but is longer. Recommendations should learn to skip primary.',
    tree,
    toolHandlers,
    conditionEvaluators: evals as Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>,
    startNodeId: 'start',
  };
}
