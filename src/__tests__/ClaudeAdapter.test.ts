import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/ClaudeAdapter.js';
import type { DecisionContext } from '../adapters/types.js';
import type { IEdge, INode } from '../core/interfaces.js';

// Mock @anthropic-ai/sdk
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

function makeContext(overrides?: Partial<DecisionContext>): DecisionContext {
  const node: INode = {
    id: 'n1',
    type: 'conversation',
    label: 'Test',
    metadata: {},
  };
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

function mockTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    mockCreate.mockReset();
    adapter = new ClaudeAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    });
  });

  it('returns exact-match edge ID', async () => {
    mockCreate.mockResolvedValueOnce(mockTextResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
  });

  it('trims whitespace', async () => {
    mockCreate.mockResolvedValueOnce(mockTextResponse('  e2  \n'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e2');
  });

  it('extracts edge ID from verbose response', async () => {
    mockCreate.mockResolvedValueOnce(
      mockTextResponse('I would choose edge e2 because...'),
    );
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e2');
  });

  it('retries on invalid response and recovers', async () => {
    mockCreate
      .mockResolvedValueOnce(mockTextResponse('garbage'))
      .mockResolvedValueOnce(mockTextResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted', async () => {
    mockCreate.mockResolvedValue(mockTextResponse('garbage'));
    await expect(adapter.decide(makeContext())).rejects.toThrow(
      'failed to select a valid edge',
    );
  });

  it('retries on 429 rate limit', async () => {
    const rateLimited = new Error('Rate limited') as Error & { status: number };
    rateLimited.status = 429;
    mockCreate
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(mockTextResponse('e1'));
    const result = await adapter.decide(makeContext());
    expect(result.chosenEdgeId).toBe('e1');
  });

  it('uses claude-haiku-4-5 as default model', async () => {
    mockCreate.mockResolvedValueOnce(mockTextResponse('e1'));
    await adapter.decide(makeContext());
    const call = mockCreate.mock.calls[0]![0] as { model: string };
    expect(call.model).toBe('claude-haiku-4-5');
  });

  it('uses custom model when specified', async () => {
    mockCreate.mockResolvedValueOnce(mockTextResponse('e1'));
    const customAdapter = new ClaudeAdapter({
      apiKey: 'test-key',
      modelName: 'claude-sonnet-4-6',
      retryDelayMs: 1,
    });
    await customAdapter.decide(makeContext());
    const call = mockCreate.mock.calls[0]![0] as { model: string };
    expect(call.model).toBe('claude-sonnet-4-6');
  });
});
