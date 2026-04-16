import OpenAI from 'openai';
import type { DecisionContext } from './ILLMDecisionTreeAdapter.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';

export interface OpenAIAdapterConfig {
  apiKey: string;
  modelName?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  maxOutputTokens?: number;
}

export class OpenAIAdapter implements IDecisionMaker {
  private client: OpenAI;
  private modelName: string;
  private maxRetries: number;
  private retryDelayMs: number;
  private maxOutputTokens: number;

  constructor(config: OpenAIAdapterConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.modelName = config.modelName ?? 'gpt-4o-mini';
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.maxOutputTokens = config.maxOutputTokens ?? 200;
  }

  async decide(
    context: DecisionContext,
  ): Promise<{ chosenEdgeId: string; reasoning?: string }> {
    const prompt = this.buildPrompt(context);
    const edgeIds = context.availableEdges.map((e) => e.id);
    let lastResponse = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const fullPrompt =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous response "${lastResponse}" did not match any valid edge. Valid edge IDs: ${edgeIds.join(', ')}. Respond with ONLY one edge ID.`;

      try {
        const responseText = await this.callWithBackoff(fullPrompt, attempt);
        lastResponse = responseText.trim();

        if (edgeIds.includes(lastResponse)) {
          return {
            chosenEdgeId: lastResponse,
            reasoning: `OpenAI selected edge "${lastResponse}"`,
          };
        }

        const matched = edgeIds.find((id) => lastResponse.includes(id));
        if (matched) {
          return {
            chosenEdgeId: matched,
            reasoning: `OpenAI response contained edge "${matched}"`,
          };
        }
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 429 && attempt < this.maxRetries) {
          continue;
        }
        if (attempt === this.maxRetries) {
          throw new Error(
            `OpenAI adapter failed after ${this.maxRetries + 1} attempts: ${error.message}`,
          );
        }
      }
    }

    throw new Error(
      `OpenAI adapter failed to select a valid edge after ${this.maxRetries + 1} attempts. ` +
        `Last response: "${lastResponse}". Valid edges: ${edgeIds.join(', ')}`,
    );
  }

  private buildPrompt(context: DecisionContext): string {
    const lines: string[] = [
      'You are a decision tree navigator. Select exactly one edge to follow.',
      '',
      `CURRENT NODE: ${context.currentNodeId} - ${context.currentNode.label} (${context.currentNode.type})`,
    ];

    const nodeData = (context.currentNode as { data?: Record<string, unknown> }).data;
    if (nodeData) {
      if (typeof nodeData.prompt === 'string') {
        lines.push(`PROMPT: ${nodeData.prompt}`);
      }
      if (nodeData.expectedResponses !== undefined) {
        lines.push(`EXPECTED RESPONSES: ${JSON.stringify(nodeData.expectedResponses)}`);
      }
      if (typeof nodeData.condition === 'string') {
        lines.push(`CONDITION: ${nodeData.condition}`);
      }
    }

    const variables = context.metadata.variables;
    if (variables !== undefined && typeof variables === 'object' && variables !== null) {
      const varsObj = variables as Record<string, unknown>;
      if (Object.keys(varsObj).length > 0) {
        lines.push(`CONTEXT: ${JSON.stringify(varsObj)}`);
      }
    }

    lines.push('');
    lines.push('AVAILABLE EDGES:');
    for (let i = 0; i < context.availableEdges.length; i++) {
      const edge = context.availableEdges[i]!;
      const target = context.availableNextNodes[i];
      const targetLabel = target?.label ?? edge.targetId;
      const condition = edge.condition ? ` (condition: "${edge.condition}")` : '';
      lines.push(`${i + 1}. Edge "${edge.id}" -> "${targetLabel}"${condition}`);
    }

    if (context.pathHistory.length > 0) {
      lines.push('');
      lines.push(`PATH SO FAR: ${context.pathHistory.join(' -> ')}`);
    }

    lines.push('');
    lines.push('Respond with ONLY the edge ID. No explanation.');
    return lines.join('\n');
  }

  private async callWithBackoff(prompt: string, attempt: number): Promise<string> {
    if (attempt > 0) {
      const delay = this.retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const completion = await this.client.chat.completions.create({
      model: this.modelName,
      max_tokens: this.maxOutputTokens,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI response contained no content');
    }
    return text;
  }
}
