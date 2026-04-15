/**
 * Scenario 7: Speed vs Accuracy
 *
 * Two paths from root: a "fast path" (2 nodes, 1 tool) with 70% failure rate,
 * and a "careful path" (4 nodes, 2 tools) with ~5% failure rate.
 * The prompt says "Choose the most efficient path."
 * Flash Lite will likely pick fast and fail. Recommendations should steer toward careful.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { ConditionalNode } from '../../../src/nodes/ConditionalNode.js';
import { createSafeToolHandler } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildSpeedVsAccuracy(): ScenarioDefinition {
  const tree = new DecisionTree();

  // Root decision
  tree.addNode(new ConversationNode('root', 'Choose Processing Path', {
    prompt: 'You need to process a data request. Choose the most efficient path to complete it successfully.',
    expectedResponses: ['fast', 'careful'],
  }));

  // ── Fast path (unreliable) ──
  tree.addNode(new ToolCallNode('fast-process', 'Quick Process', {
    toolName: 'quickProcess',
    parameters: {},
  }));
  const fastCheck = new ConditionalNode('fast-check', 'Check Quick Result', {
    condition: 'quickProcessSuccess',
    evaluator: 'quickProcessSuccess',
  });
  fastCheck.trueEdgeId = 'e-fast-success';
  fastCheck.falseEdgeId = 'e-fast-fail';
  tree.addNode(fastCheck);
  tree.addNode(new SuccessNode('fast-success', 'Quick Success', { message: 'Fast path succeeded' }));
  tree.addNode(new FailureNode('fast-fail', 'Quick Failed', {
    message: 'Fast processing failed — data corrupted',
    recoverable: false,
  }));

  // ── Careful path (reliable) ──
  tree.addNode(new ToolCallNode('validate', 'Validate Input', {
    toolName: 'validateInput',
    parameters: {},
  }));
  tree.addNode(new ToolCallNode('careful-process', 'Careful Process', {
    toolName: 'carefulProcess',
    parameters: {},
  }));
  const carefulCheck = new ConditionalNode('careful-check', 'Check Careful Result', {
    condition: 'carefulProcessSuccess',
    evaluator: 'carefulProcessSuccess',
  });
  carefulCheck.trueEdgeId = 'e-careful-success';
  carefulCheck.falseEdgeId = 'e-careful-fail';
  tree.addNode(carefulCheck);
  tree.addNode(new SuccessNode('careful-success', 'Careful Success', { message: 'Careful path succeeded' }));
  tree.addNode(new FailureNode('careful-fail', 'Careful Failed', {
    message: 'Careful processing failed',
    recoverable: false,
  }));

  // ── Edges ──
  tree.addEdge({ id: 'e-root-fast', sourceId: 'root', targetId: 'fast-process', condition: 'Fast — process immediately', metadata: {} });
  tree.addEdge({ id: 'e-root-careful', sourceId: 'root', targetId: 'validate', condition: 'Careful — validate first then process', metadata: {} });

  tree.addEdge({ id: 'e-fast-to-check', sourceId: 'fast-process', targetId: 'fast-check', metadata: {} });
  tree.addEdge({ id: 'e-fast-success', sourceId: 'fast-check', targetId: 'fast-success', metadata: {} });
  tree.addEdge({ id: 'e-fast-fail', sourceId: 'fast-check', targetId: 'fast-fail', metadata: {} });

  tree.addEdge({ id: 'e-validate-to-process', sourceId: 'validate', targetId: 'careful-process', metadata: {} });
  tree.addEdge({ id: 'e-careful-to-check', sourceId: 'careful-process', targetId: 'careful-check', metadata: {} });
  tree.addEdge({ id: 'e-careful-success', sourceId: 'careful-check', targetId: 'careful-success', metadata: {} });
  tree.addEdge({ id: 'e-careful-fail', sourceId: 'careful-check', targetId: 'careful-fail', metadata: {} });

  // ── Tool handlers ──
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();

  toolHandlers.set('quickProcess', createSafeToolHandler({
    name: 'quickProcess',
    failureRate: 0.7,
    latencyMs: 10,
    latencyJitterMs: 5,
    outputs: [{ result: 'quick-done' }],
    failureError: 'Quick process: data corruption detected',
  }));

  toolHandlers.set('validateInput', createSafeToolHandler({
    name: 'validateInput',
    failureRate: 0.0,
    latencyMs: 10,
    latencyJitterMs: 5,
    outputs: [{ validated: true }],
  }));

  toolHandlers.set('carefulProcess', createSafeToolHandler({
    name: 'carefulProcess',
    failureRate: 0.05,
    latencyMs: 15,
    latencyJitterMs: 5,
    outputs: [{ result: 'careful-done', quality: 'high' }],
    failureError: 'Careful process: unexpected error',
  }));

  // ── Condition evaluators ──
  const conditionEvaluators = new Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>();

  conditionEvaluators.set('quickProcessSuccess', (ctx) => {
    const result = ctx.variables['tool_quickProcess'] as { success?: boolean } | undefined;
    return result?.success === true;
  });

  conditionEvaluators.set('carefulProcessSuccess', (ctx) => {
    const result = ctx.variables['tool_carefulProcess'] as { success?: boolean } | undefined;
    return result?.success === true;
  });

  return {
    name: 'Speed vs Accuracy',
    description: 'Fast path (70% fail) vs careful path (5% fail). Tests whether recommendations steer away from the obvious-but-unreliable choice.',
    tree,
    toolHandlers,
    conditionEvaluators: conditionEvaluators as Map<string, (ctx: { variables: Record<string, unknown> }) => boolean>,
    startNodeId: 'root',
  };
}
