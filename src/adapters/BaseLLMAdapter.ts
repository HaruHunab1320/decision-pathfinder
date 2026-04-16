import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import type { DecisionContext } from './types.js';

export interface BaseLLMAdapterConfig {
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Shared base class for LLM-backed decision makers.
 *
 * Handles the three things every adapter needs:
 *  1. Building a structured prompt from DecisionContext
 *  2. Retrying + rate-limit backoff
 *  3. Parsing the response to an edge ID (exact match → substring match)
 *
 * Subclasses only implement callModel() with their provider's SDK.
 */
export abstract class BaseLLMAdapter implements IDecisionMaker {
  protected maxRetries: number;
  protected retryDelayMs: number;

  constructor(config?: BaseLLMAdapterConfig) {
    this.maxRetries = config?.maxRetries ?? 3;
    this.retryDelayMs = config?.retryDelayMs ?? 1000;
  }

  /** Human-readable provider name used in error messages and reasoning strings. */
  protected abstract readonly providerName: string;

  /**
   * Call the underlying LLM with the given prompt. Subclasses implement this
   * with their provider's SDK. Should throw on API errors — the retry loop
   * in decide() will handle 429s and failures.
   */
  protected abstract callModel(prompt: string): Promise<string>;

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
        if (attempt > 0) {
          await this.backoffDelay(attempt);
        }
        const responseText = await this.callModel(fullPrompt);
        lastResponse = responseText.trim();

        // Exact match
        if (edgeIds.includes(lastResponse)) {
          return {
            chosenEdgeId: lastResponse,
            reasoning: `${this.providerName} selected edge "${lastResponse}"`,
          };
        }

        // Substring match
        const matched = edgeIds.find((id) => lastResponse.includes(id));
        if (matched) {
          return {
            chosenEdgeId: matched,
            reasoning: `${this.providerName} response contained edge "${matched}"`,
          };
        }
        // else: fall through to retry with corrective prompt
      } catch (err) {
        const error = err as Error & { status?: number };
        if (error.status === 429 && attempt < this.maxRetries) {
          continue; // backoff handled at top of next iteration
        }
        if (attempt === this.maxRetries) {
          throw new Error(
            `${this.providerName} adapter failed after ${this.maxRetries + 1} attempts: ${error.message}`,
          );
        }
      }
    }

    throw new Error(
      `${this.providerName} adapter failed to select a valid edge after ${this.maxRetries + 1} attempts. ` +
        `Last response: "${lastResponse}". Valid edges: ${edgeIds.join(', ')}`,
    );
  }

  protected buildPrompt(context: DecisionContext): string {
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
      if (nodeData.expectedResponses !== undefined) {
        lines.push(
          `EXPECTED RESPONSES: ${JSON.stringify(nodeData.expectedResponses)}`,
        );
      }
      if (typeof nodeData.condition === 'string') {
        lines.push(`CONDITION: ${nodeData.condition}`);
      }
    }

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

  protected async backoffDelay(attempt: number): Promise<void> {
    const delay =
      this.retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
