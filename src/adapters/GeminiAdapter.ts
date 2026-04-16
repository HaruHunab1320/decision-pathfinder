import type { GenerativeModel } from '@google/generative-ai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseLLMAdapter, type BaseLLMAdapterConfig } from './BaseLLMAdapter.js';

export interface GeminiAdapterConfig extends BaseLLMAdapterConfig {
  apiKey: string;
  modelName?: string;
  maxOutputTokens?: number;
}

export class GeminiAdapter extends BaseLLMAdapter {
  protected readonly providerName = 'Gemini';
  private model: GenerativeModel;

  constructor(config: GeminiAdapterConfig) {
    super(config);
    const genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = genAI.getGenerativeModel({
      model: config.modelName ?? 'gemini-2.0-flash-lite',
      generationConfig: {
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : {}),
        temperature: 0,
      },
    });
  }

  protected async callModel(prompt: string): Promise<string> {
    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }
}
