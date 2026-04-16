import OpenAI from 'openai';
import { BaseLLMAdapter, type BaseLLMAdapterConfig } from './BaseLLMAdapter.js';

export interface OpenAIAdapterConfig extends BaseLLMAdapterConfig {
  apiKey: string;
  modelName?: string;
  maxOutputTokens?: number;
}

export class OpenAIAdapter extends BaseLLMAdapter {
  protected readonly providerName = 'OpenAI';
  private client: OpenAI;
  private modelName: string;
  private maxOutputTokens: number;

  constructor(config: OpenAIAdapterConfig) {
    super(config);
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.modelName = config.modelName ?? 'gpt-4o-mini';
    this.maxOutputTokens = config.maxOutputTokens ?? 200;
  }

  protected async callModel(prompt: string): Promise<string> {
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
