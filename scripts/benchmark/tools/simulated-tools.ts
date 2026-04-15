import type { ToolHandler } from '../../../src/execution/TreeExecutor.js';

export interface SimulatedToolConfig {
  name: string;
  failureRate: number;
  latencyMs: number;
  latencyJitterMs: number;
  outputs: unknown[];
  failureError?: string;
}

export function createSimulatedTool(config: SimulatedToolConfig): ToolHandler {
  return async (_params) => {
    // Simulate latency
    const delay = config.latencyMs + Math.random() * config.latencyJitterMs;
    await new Promise((r) => setTimeout(r, delay));

    // Simulate failure
    if (Math.random() < config.failureRate) {
      throw new Error(
        config.failureError ?? `Tool "${config.name}" failed`,
      );
    }

    // Return random output from pool
    const output =
      config.outputs[Math.floor(Math.random() * config.outputs.length)];
    return output;
  };
}

// Safe wrapper: catches errors and returns { success, data/error }
// so ConditionalNodes can branch on tool outcomes without the executor throwing
export function createSafeToolHandler(config: SimulatedToolConfig): ToolHandler {
  const inner = createSimulatedTool(config);
  return async (params) => {
    try {
      const result = await inner(params);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  };
}

// Deterministic tool that always succeeds with a given output
export function createStaticTool(output: unknown): ToolHandler {
  return async () => output;
}

// Tool that always fails
export function createFailingTool(error: string): ToolHandler {
  return async () => ({ success: false, error });
}
