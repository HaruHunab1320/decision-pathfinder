import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeminiAdapterConfig } from '../adapters/GeminiAdapter.js';
import { GeminiAdapter } from '../adapters/GeminiAdapter.js';
import type { DecisionContext } from '../adapters/types.js';
import type { IEdge, INode } from '../core/interfaces.js';

// Mock the @google/generative-ai module
const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({
  generateContent: mockGenerateContent,
}));

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = mockGetGenerativeModel;
    },
  };
});

function getMocks() {
  return { mockGenerateContent, mockGetGenerativeModel };
}

function makeContext(overrides?: Partial<DecisionContext>): DecisionContext {
  const defaultNode: INode = {
    id: 'n1',
    type: 'conversation',
    label: 'Test Node',
    metadata: {},
  };
  const defaultEdges: IEdge[] = [
    {
      id: 'e1',
      sourceId: 'n1',
      targetId: 'n2',
      metadata: {},
      condition: 'yes',
    },
    { id: 'e2', sourceId: 'n1', targetId: 'n3', metadata: {}, condition: 'no' },
  ];
  const defaultNextNodes: INode[] = [
    { id: 'n2', type: 'success', label: 'Success', metadata: {} },
    { id: 'n3', type: 'failure', label: 'Failure', metadata: {} },
  ];

  return {
    currentNodeId: 'n1',
    currentNode: defaultNode,
    availableEdges: defaultEdges,
    availableNextNodes: defaultNextNodes,
    pathHistory: [],
    metadata: {},
    ...overrides,
  };
}

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;
  const config: GeminiAdapterConfig = {
    apiKey: 'test-api-key',
    modelName: 'gemini-2.0-flash-lite',
    maxRetries: 2,
    retryDelayMs: 1, // Fast retries for tests
  };

  beforeEach(async () => {
    const { mockGenerateContent } = getMocks();
    mockGenerateContent.mockReset();
    adapter = new GeminiAdapter(config);
  });

  describe('decide', () => {
    it('returns exact match edge ID', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'e1' },
      });

      const result = await adapter.decide(makeContext());
      expect(result.chosenEdgeId).toBe('e1');
    });

    it('trims whitespace from response', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => '  e2  \n' },
      });

      const result = await adapter.decide(makeContext());
      expect(result.chosenEdgeId).toBe('e2');
    });

    it('extracts edge ID from noisy response', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'I would choose edge e1 because it leads to success',
        },
      });

      const result = await adapter.decide(makeContext());
      expect(result.chosenEdgeId).toBe('e1');
    });

    it('retries on invalid response and succeeds', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent
        .mockResolvedValueOnce({ response: { text: () => 'invalid_edge' } })
        .mockResolvedValueOnce({ response: { text: () => 'e2' } });

      const result = await adapter.decide(makeContext());
      expect(result.chosenEdgeId).toBe('e2');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('throws after max retries exhausted', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'garbage' },
      });

      await expect(adapter.decide(makeContext())).rejects.toThrow(
        'failed to select a valid edge',
      );
    });

    it('retries on 429 rate limit errors', async () => {
      const { mockGenerateContent } = getMocks();
      const rateLimitError = new Error('Rate limited') as Error & {
        status: number;
      };
      rateLimitError.status = 429;
      mockGenerateContent
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ response: { text: () => 'e1' } });

      const result = await adapter.decide(makeContext());
      expect(result.chosenEdgeId).toBe('e1');
    });

    it('throws non-429 errors after retries', async () => {
      const { mockGenerateContent } = getMocks();
      const serverError = new Error('Server error') as Error & {
        status: number;
      };
      serverError.status = 500;
      mockGenerateContent.mockRejectedValue(serverError);

      await expect(adapter.decide(makeContext())).rejects.toThrow(
        'Server error',
      );
    });
  });

  describe('prompt building', () => {
    it('includes node info and edges in prompt', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'e1' },
      });

      await adapter.decide(makeContext());

      const prompt = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('n1');
      expect(prompt).toContain('Test Node');
      expect(prompt).toContain('conversation');
      expect(prompt).toContain('e1');
      expect(prompt).toContain('e2');
      expect(prompt).toContain('Success');
      expect(prompt).toContain('Failure');
      expect(prompt).toContain('Respond with ONLY the edge ID');
    });

    it('includes path history when present', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'e1' },
      });

      await adapter.decide(makeContext({ pathHistory: ['start', 'middle'] }));

      const prompt = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('start -> middle');
    });

    it('includes node prompt data for conversation nodes', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'e1' },
      });

      const node: INode & { data: { prompt: string } } = {
        id: 'n1',
        type: 'conversation',
        label: 'Ask',
        metadata: {},
        data: { prompt: 'What do you want to do?' },
      };

      await adapter.decide(makeContext({ currentNode: node }));

      const prompt = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('What do you want to do?');
    });

    it('includes context variables when present', async () => {
      const { mockGenerateContent } = getMocks();
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'e1' },
      });

      await adapter.decide(
        makeContext({
          metadata: { variables: { tool_search: 'result data' } },
        }),
      );

      const prompt = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('result data');
    });
  });

  describe('configuration', () => {
    it('uses default model when not specified', () => {
      mockGetGenerativeModel.mockClear();
      new GeminiAdapter({ apiKey: 'test', retryDelayMs: 1 });

      const lastCall = mockGetGenerativeModel.mock.calls[
        mockGetGenerativeModel.mock.calls.length - 1
      ]?.[0] as { model: string };
      expect(lastCall.model).toBe('gemini-2.0-flash-lite');
    });

    it('uses custom model when specified', () => {
      mockGetGenerativeModel.mockClear();
      new GeminiAdapter({
        apiKey: 'test',
        modelName: 'gemini-pro',
        retryDelayMs: 1,
      });

      const lastCall = mockGetGenerativeModel.mock.calls[
        mockGetGenerativeModel.mock.calls.length - 1
      ]?.[0] as { model: string };
      expect(lastCall.model).toBe('gemini-pro');
    });
  });
});
