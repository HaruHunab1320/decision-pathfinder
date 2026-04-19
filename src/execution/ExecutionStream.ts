import type { INode, NodeId } from '../core/interfaces.js';
import type {
  ExecutionContext,
  ExecutionEvents,
  ExecutionResult,
  IDecisionMaker,
  TreeExecutorConfig,
} from './TreeExecutor.js';
import { TreeExecutor } from './TreeExecutor.js';
import type { IDecisionTree } from '../core/interfaces.js';
import type { IEnhancedPathTracker } from '../core/interfaces.js';

/** Event emitted during streaming execution. */
export type ExecutionEvent =
  | { type: 'step_start'; nodeId: NodeId; nodeLabel: string; nodeType: string; stepCount: number }
  | { type: 'step_complete'; nodeId: NodeId; chosenEdgeId: string; stepCount: number }
  | { type: 'tool_call'; nodeId: NodeId; toolName: string; result: unknown }
  | { type: 'condition'; nodeId: NodeId; condition: string; result: boolean }
  | { type: 'complete'; result: ExecutionResult }
  | { type: 'error'; error: string; stepCount: number };

/**
 * Wraps a TreeExecutor and yields execution events as an async iterable.
 *
 * Usage:
 * ```ts
 * const stream = new ExecutionStream(tree, decisionMaker, tracker, config);
 * for await (const event of stream.execute('start')) {
 *   console.log(event.type, event);
 * }
 * ```
 */
export class ExecutionStream {
  private tree: IDecisionTree;
  private decisionMaker: IDecisionMaker;
  private tracker: IEnhancedPathTracker;
  private config: TreeExecutorConfig | undefined;

  constructor(
    tree: IDecisionTree,
    decisionMaker: IDecisionMaker,
    tracker: IEnhancedPathTracker,
    config?: TreeExecutorConfig,
  ) {
    this.tree = tree;
    this.decisionMaker = decisionMaker;
    this.tracker = tracker;
    this.config = config;
  }

  async *execute(startNodeId: NodeId): AsyncIterableIterator<ExecutionEvent> {
    // Buffer events from the executor's callback-based system
    const buffer: ExecutionEvent[] = [];
    let resolveWaiting: (() => void) | null = null;

    function push(event: ExecutionEvent): void {
      buffer.push(event);
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    }

    const events: ExecutionEvents = {
      onStepStart: (context: ExecutionContext, node: INode) => {
        push({
          type: 'step_start',
          nodeId: node.id,
          nodeLabel: node.label,
          nodeType: node.type,
          stepCount: context.stepCount,
        });
      },
      onStepComplete: (
        context: ExecutionContext,
        _node: INode,
        chosenEdgeId: string,
      ) => {
        push({
          type: 'step_complete',
          nodeId: context.currentNodeId,
          chosenEdgeId,
          stepCount: context.stepCount,
        });
      },
      onToolCall: (nodeId: NodeId, toolName: string, result: unknown) => {
        push({ type: 'tool_call', nodeId, toolName, result });
      },
      onConditionEvaluated: (
        nodeId: NodeId,
        condition: string,
        result: boolean,
      ) => {
        push({ type: 'condition', nodeId, condition, result });
      },
    };

    const executor = new TreeExecutor(
      this.tree,
      this.decisionMaker,
      this.tracker,
      this.config,
      events,
    );

    // Start execution in the background
    const executionPromise = executor.execute(startNodeId).then((result) => {
      push({ type: 'complete', result });
    }).catch((err) => {
      push({
        type: 'error',
        error: (err as Error).message,
        stepCount: 0,
      });
    });

    // Yield events as they arrive
    let done = false;
    while (!done) {
      while (buffer.length > 0) {
        const event = buffer.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error') {
          done = true;
          break;
        }
      }
      if (!done && buffer.length === 0) {
        // Wait for the next event
        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
        });
      }
    }

    await executionPromise;
  }
}
