import type { DecisionContext } from '../adapters/types.js';
import type {
  IDecisionTree,
  IEdge,
  IEnhancedPathTracker,
  INode,
  NodeId,
} from '../core/interfaces.js';

// Decision maker interface — the executor calls this to choose an edge
export interface IDecisionMaker {
  decide(
    context: DecisionContext,
  ): Promise<{ chosenEdgeId: string; reasoning?: string }>;
}

// Tool handler function signature
export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

// Condition evaluator function signature
export type ConditionEvaluator = (
  context: ExecutionContext,
) => boolean | Promise<boolean>;

// Execution context passed around during traversal
export interface ExecutionContext {
  currentNodeId: NodeId;
  pathHistory: NodeId[];
  variables: Record<string, unknown>;
  stepCount: number;
}

// Configuration for the executor
export interface TreeExecutorConfig {
  maxSteps?: number;
  toolHandlers?: Map<string, ToolHandler>;
  conditionEvaluators?: Map<string, ConditionEvaluator>;
}

// Events emitted during execution
export interface ExecutionEvents {
  onStepStart?: (context: ExecutionContext, node: INode) => void;
  onStepComplete?: (
    context: ExecutionContext,
    node: INode,
    chosenEdgeId: string,
  ) => void;
  onToolCall?: (nodeId: NodeId, toolName: string, result: unknown) => void;
  onConditionEvaluated?: (
    nodeId: NodeId,
    condition: string,
    result: boolean,
  ) => void;
  onComplete?: (result: ExecutionResult) => void;
  onError?: (context: ExecutionContext, error: Error) => void;
}

// Final result of execution
export interface ExecutionResult {
  finalNodeId: NodeId;
  finalNode: INode;
  status: 'success' | 'failure' | 'max_steps_exceeded' | 'error';
  pathTaken: NodeId[];
  variables: Record<string, unknown>;
  stepCount: number;
  error?: string;
}

export class TreeExecutor {
  private tree: IDecisionTree;
  private decisionMaker: IDecisionMaker;
  private tracker: IEnhancedPathTracker;
  private maxSteps: number;
  private toolHandlers: Map<string, ToolHandler>;
  private conditionEvaluators: Map<string, ConditionEvaluator>;
  private events: ExecutionEvents;

  constructor(
    tree: IDecisionTree,
    decisionMaker: IDecisionMaker,
    tracker: IEnhancedPathTracker,
    config?: TreeExecutorConfig,
    events?: ExecutionEvents,
  ) {
    this.tree = tree;
    this.decisionMaker = decisionMaker;
    this.tracker = tracker;
    this.maxSteps = config?.maxSteps ?? 100;
    this.toolHandlers = config?.toolHandlers ?? new Map();
    this.conditionEvaluators = config?.conditionEvaluators ?? new Map();
    this.events = events ?? {};
  }

  async execute(startNodeId: NodeId): Promise<ExecutionResult> {
    const startNode = this.tree.getNode(startNodeId);
    if (!startNode) {
      throw new Error(`Start node "${startNodeId}" does not exist`);
    }

    this.tracker.startSession();

    const context: ExecutionContext = {
      currentNodeId: startNodeId,
      pathHistory: [],
      variables: {},
      stepCount: 0,
    };

    try {
      while (context.stepCount < this.maxSteps) {
        const node = this.tree.getNode(context.currentNodeId);
        if (!node) {
          throw new Error(
            `Node "${context.currentNodeId}" not found during execution`,
          );
        }

        context.pathHistory.push(context.currentNodeId);
        this.events.onStepStart?.(context, node);

        // Terminal nodes
        if (node.type === 'success' || node.type === 'failure') {
          this.tracker.recordEnhancedVisit(
            node.id,
            node.type === 'success' ? 'success' : 'failure',
          );
          this.tracker.endSession();

          const result: ExecutionResult = {
            finalNodeId: node.id,
            finalNode: node,
            status: node.type === 'success' ? 'success' : 'failure',
            pathTaken: context.pathHistory,
            variables: context.variables,
            stepCount: context.stepCount + 1,
          };
          this.events.onComplete?.(result);
          return result;
        }

        // Process node by type and get next node
        const nextNodeId = await this.processNode(node, context);
        context.stepCount++;
        context.currentNodeId = nextNodeId;
      }

      // Max steps exceeded
      this.tracker.endSession();
      const currentNode = this.tree.getNode(context.currentNodeId)!;
      const result: ExecutionResult = {
        finalNodeId: context.currentNodeId,
        finalNode: currentNode,
        status: 'max_steps_exceeded',
        pathTaken: context.pathHistory,
        variables: context.variables,
        stepCount: context.stepCount,
        error: `Execution exceeded maximum steps (${this.maxSteps})`,
      };
      this.events.onComplete?.(result);
      return result;
    } catch (err) {
      this.tracker.endSession();
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.onError?.(context, error);
      return {
        finalNodeId: context.currentNodeId,
        finalNode: this.tree.getNode(context.currentNodeId)!,
        status: 'error',
        pathTaken: context.pathHistory,
        variables: context.variables,
        stepCount: context.stepCount,
        error: error.message,
      };
    }
  }

  private async processNode(
    node: INode,
    context: ExecutionContext,
  ): Promise<NodeId> {
    const outgoingEdges = this.tree.getOutgoingEdges(node.id);

    if (node.type === 'conditional') {
      return this.processConditionalNode(node, context, outgoingEdges);
    }

    if (node.type === 'tool_call') {
      return this.processToolCallNode(node, context, outgoingEdges);
    }

    // Conversation nodes and any other type — ask the LLM
    return this.processDecisionNode(node, context, outgoingEdges);
  }

  private async processConditionalNode(
    node: INode,
    context: ExecutionContext,
    outgoingEdges: IEdge[],
  ): Promise<NodeId> {
    const data = (
      node as INode & { data: { condition: string; evaluator?: string } }
    ).data;
    const trueEdgeId = (node as INode & { trueEdgeId?: string }).trueEdgeId;
    const falseEdgeId = (node as INode & { falseEdgeId?: string }).falseEdgeId;

    const evaluatorKey = data?.evaluator ?? data?.condition ?? 'default';
    const evaluator = this.conditionEvaluators.get(evaluatorKey);

    if (!evaluator) {
      // Fall back to LLM decision if no evaluator registered
      this.tracker.recordEnhancedVisit(node.id, 'pending');
      return this.processDecisionNode(node, context, outgoingEdges);
    }

    const result = await evaluator(context);
    this.events.onConditionEvaluated?.(node.id, evaluatorKey, result);

    const chosenEdgeId = result ? trueEdgeId : falseEdgeId;
    if (!chosenEdgeId) {
      // If trueEdgeId/falseEdgeId not set, fall back to LLM
      this.tracker.recordEnhancedVisit(node.id, 'pending');
      return this.processDecisionNode(node, context, outgoingEdges);
    }

    const edge = outgoingEdges.find((e) => e.id === chosenEdgeId);
    if (!edge) {
      throw new Error(
        `Conditional edge "${chosenEdgeId}" not found for node "${node.id}"`,
      );
    }

    this.tracker.recordEnhancedVisit(node.id, 'success');
    this.events.onStepComplete?.(context, node, chosenEdgeId);
    return edge.targetId;
  }

  private async processToolCallNode(
    node: INode,
    context: ExecutionContext,
    outgoingEdges: IEdge[],
  ): Promise<NodeId> {
    const data = (
      node as INode & {
        data: { toolName: string; parameters: Record<string, unknown> };
      }
    ).data;
    const handler = this.toolHandlers.get(data.toolName);

    if (!handler) {
      this.tracker.recordEnhancedVisit(node.id, 'failure', {
        error: `No handler registered for tool "${data.toolName}"`,
      });
      throw new Error(`No handler registered for tool "${data.toolName}"`);
    }

    try {
      const toolResult = await handler(data.parameters);
      context.variables[`tool_${data.toolName}`] = toolResult;
      this.events.onToolCall?.(node.id, data.toolName, toolResult);

      this.tracker.recordEnhancedVisit(node.id, 'success', {
        toolOutput: toolResult,
      });

      // If only one outgoing edge, follow it directly
      if (outgoingEdges.length === 1) {
        const edge = outgoingEdges[0]!;
        this.events.onStepComplete?.(context, node, edge.id);
        return edge.targetId;
      }

      // Multiple edges — ask LLM which to take, with tool output in context
      return this.processDecisionNode(node, context, outgoingEdges);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.tracker.recordEnhancedVisit(node.id, 'failure', {
        error: error.message,
      });
      throw error;
    }
  }

  private async processDecisionNode(
    node: INode,
    context: ExecutionContext,
    outgoingEdges: IEdge[],
  ): Promise<NodeId> {
    if (outgoingEdges.length === 0) {
      throw new Error(
        `Node "${node.id}" has no outgoing edges and is not a terminal node`,
      );
    }

    // Single edge — no decision needed
    if (outgoingEdges.length === 1) {
      const edge = outgoingEdges[0]!;
      this.tracker.recordEnhancedVisit(node.id, 'success');
      this.events.onStepComplete?.(context, node, edge.id);
      return edge.targetId;
    }

    const availableNextNodes: INode[] = [];
    for (const edge of outgoingEdges) {
      const targetNode = this.tree.getNode(edge.targetId);
      if (targetNode) {
        availableNextNodes.push(targetNode);
      }
    }

    const decisionContext: DecisionContext = {
      currentNodeId: node.id,
      currentNode: node,
      availableEdges: outgoingEdges,
      availableNextNodes,
      pathHistory: context.pathHistory,
      metadata: { ...node.metadata, variables: context.variables },
    };

    const decision = await this.decisionMaker.decide(decisionContext);

    // Validate chosen edge
    const chosenEdge = outgoingEdges.find(
      (e) => e.id === decision.chosenEdgeId,
    );
    if (!chosenEdge) {
      throw new Error(
        `Decision maker chose invalid edge "${decision.chosenEdgeId}" for node "${node.id}". ` +
          `Valid edges: ${outgoingEdges.map((e) => e.id).join(', ')}`,
      );
    }

    this.tracker.recordEnhancedVisit(node.id, 'success', {
      ...(decision.reasoning !== undefined
        ? { reasoning: decision.reasoning }
        : {}),
    });
    this.events.onStepComplete?.(context, node, decision.chosenEdgeId);
    return chosenEdge.targetId;
  }
}

// Simple mock decision maker for testing — follows a predetermined path or picks first edge
export class MockDecisionMaker implements IDecisionMaker {
  private pathToFollow: string[];
  private pathIndex = 0;

  constructor(edgeIdsToFollow?: string[]) {
    this.pathToFollow = edgeIdsToFollow ?? [];
  }

  async decide(
    context: DecisionContext,
  ): Promise<{ chosenEdgeId: string; reasoning?: string }> {
    if (this.pathIndex < this.pathToFollow.length) {
      const edgeId = this.pathToFollow[this.pathIndex]!;
      this.pathIndex++;
      return {
        chosenEdgeId: edgeId,
        reasoning: 'Following predetermined path',
      };
    }

    // Default: pick the first available edge
    if (context.availableEdges.length === 0) {
      throw new Error('No available edges to choose from');
    }

    return {
      chosenEdgeId: context.availableEdges[0]!.id,
      reasoning: 'Default: picked first available edge',
    };
  }
}
