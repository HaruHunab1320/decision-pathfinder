import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../adapters/OpenAIAdapter.js';
import type { DecisionContext } from '../adapters/ILLMDecisionTreeAdapter.js';
import type { IEdge, INode } from '../core/interfaces.js';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class {
      constructor(_config: { apiKey: string }) {}
      chat = { completions: { create: mockCreate } };
    },
  };
});

function makeContext(overrides?: Partial<DecisionContext>): DecisionContext {
  const node: INode = { id: 'n1', type: 'conversation', label: 'Test', metadata: {} };
  const edges: IEdge[] = [
    { id: 'e1', sourceId: 'n1', targetId: 'n2', metadata: {} },
    { id: 'e2', sourceId: 'n1', targetId: 'n3', metadata: {} },
  ];
  const next: INode[] = [
    { id: 'n2', type: 'success', label: 'A', metadata: {} },
    { id: 'n3', type: 'failure', label: 'B', metadata: {} },
  ];
  return {
    currentNodeId: 'n1',
    currentNode: node,
    availableEdges: edges,
    availableNextNodes: next,
    pathHistory: [],
    metadata: {},
    ...overrides,
  };
}

function mockChatResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    mockCreate.mockReset();
    adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    });
  });

  it('returns exact-match edge ID', async () => {
    mockCreate.mockResolvedValueOnce(mockChatResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
  });

  it('trims whitespace', async () => {
    mockCreate.mockResolvedValueOnce(mockChatResponse('  e2  \n'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e2');
  });

  it('extracts edge ID from verbose response', async () => {
    mockCreate.mockResolvedValueOnce(
      mockChatResponse('Based on the context, I recommend edge e2.'),
    );
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e2');
  });

  it('retries on invalid response', async () => {
    mockCreate
      .mockResolvedValueOnce(mockChatResponse('junk'))
      .mockResolvedValueOnce(mockChatResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    mockCreate.mockResolvedValue(mockChatResponse('junk'));
    await expect(adapter.decide(makeContext())).rejects.toThrow(
      'failed to select a valid edge',
    );
  });

  it('retries on 429', async () => {
    const rateLimited = new Error('Rate limited') as Error & { status: number };
    rateLimited.status = 429;
    mockCreate
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(mockChatResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
  });

  it('uses gpt-4o-mini as default model', async () => {
    mockCreate.mockResolvedValueOnce(mockChatResponse('e1'));
    await adapter.decide(makeContext());
    const call = mockCreate.mock.calls[0]![0] as { model: string };
    expect(call.model).toBe('gpt-4o-mini');
  });
});
