/**
 * Scenario 2: Tool Chain with Failures
 *
 * Linear chain: validate -> fetch -> transform -> save
 * fetchData has 40% failure rate. After each tool, a conditional checks success.
 * On failure, a fallback tool is available. The tree should learn that
 * fetchData is unreliable and (via recommendations) prefer the fallback.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { ConditionalNode } from '../../../src/nodes/ConditionalNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { createSafeToolHandler } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildToolChainFailures(): ScenarioDefinition {
  const tree = new DecisionTree();

  // Step 1: Validate (reliable)
  tree.addNode(new ToolCallNode('validate', 'Validate Input', {
    toolName: 'validate', parameters: {},
  }));
  const valCheck = new ConditionalNode('val-check', 'Check Validation', {
    condition: 'validateSuccess', evaluator: 'validateSuccess',
  });
  valCheck.trueEdgeId = 'e-val-ok';
  valCheck.falseEdgeId = 'e-val-fail';
  tree.addNode(valCheck);

  // Step 2: Fetch — choose primary or fallback
  tree.addNode(new ConversationNode('fetch-choice', 'Choose Data Source', {
    prompt: 'Choose a data source. The primary source is faster but may be unreliable. The fallback source is slower but more stable.',
  }));

  tree.addNode(new ToolCallNode('fetch-primary', 'Fetch from Primary', {
    toolName: 'fetchPrimary', parameters: {},
  }));
  tree.addNode(new ToolCallNode('fetch-fallback', 'Fetch from Fallback', {
    toolName: 'fetchFallback', parameters: {},
  }));

  const fetchPCheck = new ConditionalNode('fetch-p-check', 'Check Primary Fetch', {
    condition: 'fetchPrimarySuccess', evaluator: 'fetchPrimarySuccess',
  });
  fetchPCheck.trueEdgeId = 'e-fetchp-ok';
  fetchPCheck.falseEdgeId = 'e-fetchp-fail';
  tree.addNode(fetchPCheck);

  const fetchFCheck = new ConditionalNode('fetch-f-check', 'Check Fallback Fetch', {
    condition: 'fetchFallbackSuccess', evaluator: 'fetchFallbackSuccess',
  });
  fetchFCheck.trueEdgeId = 'e-fetchf-ok';
  fetchFCheck.falseEdgeId = 'e-fetchf-fail';
  tree.addNode(fetchFCheck);

  // Step 3: Transform (reliable)
  tree.addNode(new ToolCallNode('transform', 'Transform Data', {
    toolName: 'transform', parameters: {},
  }));

  // Step 4: Save (reliable)
  tree.addNode(new ToolCallNode('save', 'Save Results', {
    toolName: 'save', parameters: {},
  }));

  // Terminal nodes
  tree.addNode(new SuccessNode('done', 'Pipeline Complete', { message: 'Data pipeline completed successfully' }));
  tree.addNode(new FailureNode('val-failed', 'Validation Failed', { message: 'Input validation failed', recoverable: false }));
  tree.addNode(new FailureNode('fetch-failed', 'Fetch Failed', { message: 'Both data sources failed', recoverable: false }));

  // ── Edges ──
  tree.addEdge({ id: 'e-start-val', sourceId: 'validate', targetId: 'val-check', metadata: {} });
  tree.addEdge({ id: 'e-val-ok', sourceId: 'val-check', targetId: 'fetch-choice', metadata: {} });
  tree.addEdge({ id: 'e-val-fail', sourceId: 'val-check', targetId: 'val-failed', metadata: {} });

  tree.addEdge({ id: 'e-choice-primary', sourceId: 'fetch-choice', targetId: 'fetch-primary', condition: 'Use primary source (faster)', metadata: {} });
  tree.addEdge({ id: 'e-choice-fallback', sourceId: 'fetch-choice', targetId: 'fetch-fallback', condition: 'Use fallback source (more reliable)', metadata: {} });

  tree.addEdge({ id: 'e-fetchp-to-check', sourceId: 'fetch-primary', targetId: 'fetch-p-check', metadata: {} });
  tree.addEdge({ id: 'e-fetchp-ok', sourceId: 'fetch-p-check', targetId: 'transform', metadata: {} });
  tree.addEdge({ id: 'e-fetchp-fail', sourceId: 'fetch-p-check', targetId: 'fetch-failed', metadata: {} });

  tree.addEdge({ id: 'e-fetchf-to-check', sourceId: 'fetch-fallback', targetId: 'fetch-f-check', metadata: {} });
  tree.addEdge({ id: 'e-fetchf-ok', sourceId: 'fetch-f-check', targetId: 'transform', metadata: {} });
  tree.addEdge({ id: 'e-fetchf-fail', sourceId: 'fetch-f-check', targetId: 'fetch-failed', metadata: {} });

  tree.addEdge({ id: 'e-transform-save', sourceId: 'transform', targetId: 'save', metadata: {} });
  tree.addEdge({ id: 'e-save-done', sourceId: 'save', targetId: 'done', metadata: {} });

  // ── Tool handlers ──
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();

  toolHandlers.set('validate', createSafeToolHandler({
    name: 'validate', failureRate: 0.05, latencyMs: 10, latencyJitterMs: 5,
    outputs: [{ valid: true }],
  }));
  toolHandlers.set('fetchPrimary', createSafeToolHandler({
    name: 'fetchPrimary', failureRate: 0.4, latencyMs: 10, latencyJitterMs: 5,
    outputs: [{ data: [1, 2, 3], source: 'primary' }],
    failureError: 'Primary source: connection timeout',
  }));
  toolHandlers.set('fetchFallback', createSafeToolHandler({
    name: 'fetchFallback', failureRate: 0.05, latencyMs: 20, latencyJitterMs: 10,
    outputs: [{ data: [1, 2, 3], source: 'fallback' }],
    failureError: 'Fallback source: rate limited',
  }));
  toolHandlers.set('transform', createSafeToolHandler({
    name: 'transform', failureRate: 0.0, latencyMs: 10, latencyJitterMs: 5,
    outputs: [{ transformed: true }],
  }));
  toolHandlers.set('save', createSafeToolHandler({
    name: 'save', failureRate: 0.0, latencyMs: 10, latencyJitterMs: 5,
    outputs: [{ saved: true }],
  }));

  // ── Condition evaluators ──
  const evals = new Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>();
  evals.set('validateSuccess', (ctx) => {
    const r = ctx.variables['tool_validate'] as { success?: boolean } | undefined;
    return r?.success === true;
  });
  evals.set('fetchPrimarySuccess', (ctx) => {
    const r = ctx.variables['tool_fetchPrimary'] as { success?: boolean } | undefined;
    return r?.success === true;
  });
  evals.set('fetchFallbackSuccess', (ctx) => {
    const r = ctx.variables['tool_fetchFallback'] as { success?: boolean } | undefined;
    return r?.success === true;
  });

  return {
    name: 'Tool Chain Failures',
    description: 'Data pipeline where the primary fetch source has 40% failure rate. Recommendations should steer toward the reliable fallback.',
    tree,
    toolHandlers,
    conditionEvaluators: evals as Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>,
    startNodeId: 'validate',
  };
}
