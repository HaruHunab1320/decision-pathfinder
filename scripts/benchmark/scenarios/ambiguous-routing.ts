/**
 * Scenario 1: Ambiguous Routing
 *
 * A tool analyzes "customer sentiment" and produces context. Then a 3-way
 * ConversationNode must route based on subtle clues. Only one path succeeds.
 * The prompt is deliberately vague to force the LLM to rely on context variables.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { createStaticTool } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildAmbiguousRouting(): ScenarioDefinition {
  const tree = new DecisionTree();

  tree.addNode(new ToolCallNode('analyze', 'Analyze Customer Sentiment', {
    toolName: 'analyzeSentiment',
    parameters: {},
  }));

  tree.addNode(new ConversationNode('route', 'Route Customer Request', {
    prompt: 'A customer is unhappy with their recent purchase. Based on the sentiment analysis in the context, choose the best resolution path. The analysis indicates the customer mentioned "broken item" and "need it working by Friday" — they did NOT mention wanting money back.',
    expectedResponses: ['refund', 'replacement', 'store-credit'],
  }));

  tree.addNode(new SuccessNode('replacement-ok', 'Replacement Sent', {
    message: 'Customer received expedited replacement — issue resolved',
  }));
  tree.addNode(new FailureNode('refund-wrong', 'Wrong Resolution', {
    message: 'Customer wanted a working item, not a refund. They are still without the product.',
    recoverable: false,
  }));
  tree.addNode(new FailureNode('credit-wrong', 'Wrong Resolution', {
    message: 'Store credit does not solve their immediate need for a working item by Friday.',
    recoverable: false,
  }));

  // Edges
  tree.addEdge({ id: 'e-analyze-route', sourceId: 'analyze', targetId: 'route', metadata: {} });
  tree.addEdge({ id: 'e-route-refund', sourceId: 'route', targetId: 'refund-wrong', condition: 'Customer wants refund', metadata: {} });
  tree.addEdge({ id: 'e-route-replacement', sourceId: 'route', targetId: 'replacement-ok', condition: 'Customer wants replacement', metadata: {} });
  tree.addEdge({ id: 'e-route-credit', sourceId: 'route', targetId: 'credit-wrong', condition: 'Customer wants store credit', metadata: {} });

  // Tool handlers
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();
  toolHandlers.set('analyzeSentiment', createStaticTool({
    sentiment: 'frustrated',
    keywords: ['broken item', 'need it working', 'by Friday', 'urgent'],
    preferredOutcome: 'functional_product',
    mentionedRefund: false,
    mentionedReplacement: true,
  }));

  return {
    name: 'Ambiguous Routing',
    description: '3-way routing based on subtle context clues. Only "replacement" is correct — the customer needs a working item, not money.',
    tree,
    toolHandlers,
    conditionEvaluators: new Map(),
    startNodeId: 'analyze',
  };
}
