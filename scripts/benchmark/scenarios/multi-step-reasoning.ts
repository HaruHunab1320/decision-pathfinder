/**
 * Scenario 3: Multi-Step Reasoning
 *
 * 3 tools gather clues, then the LLM must combine them at a 3-way branch.
 * The correct answer requires reading all three tool outputs together.
 * Flash Lite's weakness at maintaining context over many steps.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { createStaticTool } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildMultiStepReasoning(): ScenarioDefinition {
  const tree = new DecisionTree();

  // Clue 1: Location data
  tree.addNode(new ToolCallNode('clue1', 'Gather Location Data', {
    toolName: 'getLocation', parameters: {},
  }));
  // Clue 2: Time data
  tree.addNode(new ToolCallNode('clue2', 'Gather Time Data', {
    toolName: 'getTime', parameters: {},
  }));
  // Clue 3: Profile data
  tree.addNode(new ToolCallNode('clue3', 'Gather Profile Data', {
    toolName: 'getProfile', parameters: {},
  }));

  // Intermediate conversation nodes that add context
  tree.addNode(new ConversationNode('reflect1', 'Process Location', {
    prompt: 'The location data has been gathered. Continue to the next clue.',
  }));
  tree.addNode(new ConversationNode('reflect2', 'Process Time', {
    prompt: 'The time data has been gathered. Continue to the next clue.',
  }));

  // Final decision: must combine all 3 clues
  tree.addNode(new ConversationNode('decide', 'Determine Deployment Region', {
    prompt: `Based on ALL the gathered data in context, determine the correct deployment region.

Key reasoning required:
- The location data shows the user is in a UTC+9 timezone (tool_getLocation)
- The time data shows peak traffic occurs during Asian business hours (tool_getTime)
- The profile data shows the account is configured for JPY currency (tool_getProfile)

Combining these three facts: UTC+9 + Asian business hours + JPY currency = Japan.
Select the correct deployment region.`,
    expectedResponses: ['us-east', 'eu-west', 'ap-northeast'],
  }));

  tree.addNode(new SuccessNode('correct', 'Correct Region', {
    message: 'Deployed to ap-northeast (Japan) — all clues correctly combined',
  }));
  tree.addNode(new FailureNode('wrong-us', 'Wrong Region', {
    message: 'us-east is incorrect. The clues point to Japan (UTC+9, JPY, Asian hours).',
    recoverable: false,
  }));
  tree.addNode(new FailureNode('wrong-eu', 'Wrong Region', {
    message: 'eu-west is incorrect. The clues point to Japan (UTC+9, JPY, Asian hours).',
    recoverable: false,
  }));

  // Edges — linear chain with decision at the end
  tree.addEdge({ id: 'e-c1-r1', sourceId: 'clue1', targetId: 'reflect1', metadata: {} });
  tree.addEdge({ id: 'e-r1-c2', sourceId: 'reflect1', targetId: 'clue2', metadata: {} });
  tree.addEdge({ id: 'e-c2-r2', sourceId: 'clue2', targetId: 'reflect2', metadata: {} });
  tree.addEdge({ id: 'e-r2-c3', sourceId: 'reflect2', targetId: 'clue3', metadata: {} });
  tree.addEdge({ id: 'e-c3-decide', sourceId: 'clue3', targetId: 'decide', metadata: {} });

  tree.addEdge({ id: 'e-decide-us', sourceId: 'decide', targetId: 'wrong-us', condition: 'Deploy to us-east (US East)', metadata: {} });
  tree.addEdge({ id: 'e-decide-eu', sourceId: 'decide', targetId: 'wrong-eu', condition: 'Deploy to eu-west (EU West)', metadata: {} });
  tree.addEdge({ id: 'e-decide-ap', sourceId: 'decide', targetId: 'correct', condition: 'Deploy to ap-northeast (Japan)', metadata: {} });

  // Tool handlers
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();
  toolHandlers.set('getLocation', createStaticTool({
    timezone: 'UTC+9',
    coordinates: { lat: 35.6762, lng: 139.6503 },
    country_code: 'JP',
  }));
  toolHandlers.set('getTime', createStaticTool({
    peakHours: '09:00-18:00 JST',
    trafficPattern: 'Asian business hours',
    lowestLatency: 'ap-northeast-1',
  }));
  toolHandlers.set('getProfile', createStaticTool({
    currency: 'JPY',
    language: 'ja',
    complianceRegion: 'APAC',
  }));

  return {
    name: 'Multi-Step Reasoning',
    description: '3 tool calls gather clues, then a 3-way decision requires combining all of them. Correct answer: ap-northeast (Japan).',
    tree,
    toolHandlers,
    conditionEvaluators: new Map(),
    startNodeId: 'clue1',
  };
}
