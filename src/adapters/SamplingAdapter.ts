import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import type { DecisionContext } from './types.js';

/**
 * Decision maker that uses MCP sampling (server.createMessage) to ask
 * the host LLM for a decision. No API keys needed — the host handles it.
 *
 * Falls back gracefully: if sampling fails (host doesn't support it),
 * the error surfaces so the caller can switch to an API-key adapter.
 */
export class SamplingAdapter implements IDecisionMaker {
  constructor(private server: Server) {}

  async decide(
    context: DecisionContext,
  ): Promise<{ chosenEdgeId: string; reasoning?: string }> {
    const prompt = this.buildPrompt(context);
    const edgeIds = context.availableEdges.map((e) => e.id);

    const result = await this.server.createMessage({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: prompt },
        },
      ],
      maxTokens: 100,
      modelPreferences: {
        costPriority: 1, // prefer cheap models for routing
        speedPriority: 0.8,
        intelligencePriority: 0.3,
      },
    });

    const responseText =
      result.content.type === 'text' ? result.content.text.trim() : '';

    // Exact match
    if (edgeIds.includes(responseText)) {
      return {
        chosenEdgeId: responseText,
        reasoning: `Sampling selected edge "${responseText}"`,
      };
    }

    // Substring match
    const matched = edgeIds.find((id) => responseText.includes(id));
    if (matched) {
      return {
        chosenEdgeId: matched,
        reasoning: `Sampling response contained edge "${matched}"`,
      };
    }

    throw new Error(
      `Sampling response "${responseText}" did not match any valid edge: ${edgeIds.join(', ')}`,
    );
  }

  private buildPrompt(context: DecisionContext): string {
    const lines: string[] = [
      'You are a decision tree navigator. Select exactly one edge to follow.',
      '',
      `CURRENT NODE: ${context.currentNodeId} - ${context.currentNode.label} (${context.currentNode.type})`,
    ];

    const nodeData = (context.currentNode as { data?: Record<string, unknown> })
      .data;
    if (nodeData) {
      if (typeof nodeData.prompt === 'string') {
        lines.push(`PROMPT: ${nodeData.prompt}`);
      }
      if (typeof nodeData.condition === 'string') {
        lines.push(`CONDITION: ${nodeData.condition}`);
      }
    }

    lines.push('');
    lines.push('AVAILABLE EDGES:');
    for (let i = 0; i < context.availableEdges.length; i++) {
      const edge = context.availableEdges[i]!;
      const target = context.availableNextNodes[i];
      const targetLabel = target?.label ?? edge.targetId;
      const condition = edge.condition
        ? ` (condition: "${edge.condition}")`
        : '';
      lines.push(
        `${i + 1}. Edge "${edge.id}" -> "${targetLabel}"${condition}`,
      );
    }

    lines.push('');
    lines.push('Respond with ONLY the edge ID. No explanation.');
    return lines.join('\n');
  }
}

/**
 * Check if the connected MCP client supports sampling.
 * Returns true if createMessage is available.
 */
export function isSamplingAvailable(server: Server): boolean {
  try {
    // The server's getClientCapabilities() returns what the client declared
    const caps = server.getClientCapabilities();
    return caps?.sampling !== undefined;
  } catch {
    return false;
  }
}
