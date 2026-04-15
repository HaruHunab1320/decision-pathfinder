/**
 * Scenario 5: High Branching Factor
 *
 * A single critical ConversationNode with 6 outgoing edges (geographic regions).
 * Subtle clues in context (timezone, currency, language) point to one correct region.
 */
import { DecisionTree } from '../../../src/core/DecisionTree.js';
import { ConversationNode } from '../../../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../../../src/nodes/ToolCallNode.js';
import { SuccessNode } from '../../../src/nodes/SuccessNode.js';
import { FailureNode } from '../../../src/nodes/FailureNode.js';
import { createStaticTool } from '../tools/simulated-tools.js';
import type { ScenarioDefinition } from '../types.js';

export function buildHighBranching(): ScenarioDefinition {
  const tree = new DecisionTree();

  // Gather context
  tree.addNode(new ToolCallNode('gather', 'Gather Regional Clues', {
    toolName: 'gatherClues', parameters: {},
  }));

  // 6-way decision
  tree.addNode(new ConversationNode('pick-region', 'Select Deployment Region', {
    prompt: `Select the correct deployment region based on the gathered clues in context.

The clues indicate:
- Currency: BRL (Brazilian Real)
- Primary language: pt-BR (Portuguese, Brazil)
- Timezone offset: UTC-3
- Compliance framework: LGPD (Brazil's data protection law)

Match these clues to the correct region. Only ONE region matches all four clues.`,
  }));

  // 6 region endpoints — only Latin America is correct
  const regions = [
    { id: 'na', label: 'North America', correct: false },
    { id: 'eu', label: 'Europe', correct: false },
    { id: 'ap', label: 'Asia-Pacific', correct: false },
    { id: 'la', label: 'Latin America', correct: true },
    { id: 'me', label: 'Middle East', correct: false },
    { id: 'af', label: 'Africa', correct: false },
  ];

  for (const region of regions) {
    if (region.correct) {
      tree.addNode(new SuccessNode(`region-${region.id}`, `Deployed to ${region.label}`, {
        message: `Correctly deployed to ${region.label} — all clues match`,
      }));
    } else {
      tree.addNode(new FailureNode(`region-${region.id}`, `Wrong: ${region.label}`, {
        message: `${region.label} does not match: BRL + pt-BR + UTC-3 + LGPD = Brazil (Latin America)`,
        recoverable: false,
      }));
    }
    tree.addEdge({
      id: `e-pick-${region.id}`,
      sourceId: 'pick-region',
      targetId: `region-${region.id}`,
      condition: `Deploy to ${region.label}`,
      metadata: {},
    });
  }

  tree.addEdge({ id: 'e-gather-pick', sourceId: 'gather', targetId: 'pick-region', metadata: {} });

  // Tool handler
  const toolHandlers = new Map<string, import('../../../src/execution/TreeExecutor.js').ToolHandler>();
  toolHandlers.set('gatherClues', createStaticTool({
    currency: 'BRL',
    language: 'pt-BR',
    timezoneOffset: 'UTC-3',
    complianceFramework: 'LGPD',
    ipGeoHint: 'South America',
  }));

  return {
    name: 'High Branching Factor',
    description: '6-way region selection from subtle clues (BRL, pt-BR, UTC-3, LGPD). Only Latin America is correct.',
    tree,
    toolHandlers,
    conditionEvaluators: new Map(),
    startNodeId: 'gather',
  };
}
