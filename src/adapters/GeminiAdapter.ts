import type { GenerativeModel } from '@google/generative-ai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import type { DecisionContext } from './ILLMDecisionTreeAdapter.js';

export interface GeminiAdapterConfig {
  apiKey: string;
  modelName?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  maxOutputTokens?: number;
}

export class GeminiAdapter implements IDecisionMaker {
  private model: GenerativeModel;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(config: GeminiAdapterConfig) {
    const genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = genAI.getGenerativeModel({
      model: config.modelName ?? 'gemini-2.0-flash-lite',
      generationConfig: {
        maxOutputTokens: config.maxOutputTokens ?? 50,
        temperature: 0,
      },
    });
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
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
          : `${prompt}\n\nYour previous response "${lastResponse}" did not match any valid edge. The valid edge IDs are: ${edgeIds.join(', ')}. Respond with ONLY one edge ID.`;

      try {
        const result = await this.callWithBackoff(fullPrompt, attempt);
        const responseText = result.trim();
        lastResponse = responseText;

        // Exact match
        if (edgeIds.includes(responseText)) {
          return {
            chosenEdgeId: responseText,
            reasoning: `Gemini selected edge "${responseText}"`,
          };
        }

        // Substring match — find an edge ID within the response
        const matchedEdge = edgeIds.find((id) => responseText.includes(id));
        if (matchedEdge) {
          return {
            chosenEdgeId: matchedEdge,
            reasoning: `Gemini response contained edge "${matchedEdge}"`,
          };
        }

        // No match — retry
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 429 && attempt < this.maxRetries) {
          // Rate limited — backoff handled by callWithBackoff on next attempt
          continue;
        }
        if (attempt === this.maxRetries) {
          throw new Error(
            `Gemini adapter failed after ${this.maxRetries + 1} attempts: ${error.message}`,
          );
        }
      }
    }

    throw new Error(
      `Gemini adapter failed to select a valid edge after ${this.maxRetries + 1} attempts. ` +
        `Last response: "${lastResponse}". Valid edges: ${edgeIds.join(', ')}`,
    );
  }

  private buildPrompt(context: DecisionContext): string {
    const lines: string[] = [
      'You are a decision tree navigator. Select exactly one edge to follow.',
      '',
      `CURRENT NODE: ${context.currentNodeId} - ${context.currentNode.label} (${context.currentNode.type})`,
    ];

    // Add node-specific content
    const nodeData = (context.currentNode as { data?: Record<string, unknown> })
      .data;
    if (nodeData) {
      if (typeof nodeData.prompt === 'string') {
        lines.push(`PROMPT: ${nodeData.prompt}`);
      }
      if (nodeData.expectedResponses !== undefined) {
        lines.push(
          `EXPECTED RESPONSES: ${JSON.stringify(nodeData.expectedResponses)}`,
        );
      }
      if (typeof nodeData.condition === 'string') {
        lines.push(`CONDITION: ${nodeData.condition}`);
      }
    }

    // Add variables/tool output if present
    const variables = context.metadata.variables;
    if (
      variables !== undefined &&
      typeof variables === 'object' &&
      variables !== null
    ) {
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
      const condition = edge.condition
        ? ` (condition: "${edge.condition}")`
        : '';
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

  private async callWithBackoff(
    prompt: string,
    attempt: number,
  ): Promise<string> {
    if (attempt > 0) {
      const delay =
        this.retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }
}
