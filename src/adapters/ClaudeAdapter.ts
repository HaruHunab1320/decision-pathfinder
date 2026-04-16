import Anthropic from '@anthropic-ai/sdk';
import { BaseLLMAdapter, type BaseLLMAdapterConfig } from './BaseLLMAdapter.js';

export interface ClaudeAdapterConfig extends BaseLLMAdapterConfig {
  apiKey: string;
  modelName?: string;
  maxOutputTokens?: number;
}

export class ClaudeAdapter extends BaseLLMAdapter {
  protected readonly providerName = 'Claude';
  private client: Anthropic;
  private modelName: string;
  private maxOutputTokens: number;

  constructor(config: ClaudeAdapterConfig) {
    super(config);
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.modelName = config.modelName ?? 'claude-haiku-4-5';
    this.maxOutputTokens = config.maxOutputTokens ?? 200;
  }

  protected async callModel(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: this.maxOutputTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((c) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude response contained no text block');
    }
    return textBlock.text;
  }
}
