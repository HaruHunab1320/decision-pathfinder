#!/usr/bin/env node
/**
 * decision-pathfinder MCP server
 *
 * Exposes decision tree operations as MCP tools for Claude Code, Cursor, etc.
 * Runs locally on the user's machine via stdio transport.
 *
 * Tools:
 *   Recording (capture what the LLM is doing as a decision tree):
 *     dp_start_recording   — Begin recording a new task as a tree
 *     dp_record_step       — Append a step (tool call, conversation, condition)
 *     dp_record_branch     — Mark a decision point with alternatives considered
 *     dp_finalize_recording — End recording with success/failure, optionally save
 *
 *   Playback / execution:
 *     dp_load_tree         — Load a tree from JSON file or inline
 *     dp_list_trees        — List all loaded trees
 *     dp_execute_tree      — Execute a tree (auto-uses recommendations)
 *     dp_get_recommendation — Get edge recommendation at a node
 *     dp_get_analytics     — Get execution analytics and bottleneck report
 *     dp_export_tree       — Export a tree to JSON
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DecisionTree } from '../core/DecisionTree.js';
import { TreeSerializer } from '../serialization/TreeSerializer.js';
import { PathTracker } from '../tracking/PathTracker.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';
import { TreeExecutor, MockDecisionMaker } from '../execution/TreeExecutor.js';
import { GeminiAdapter } from '../adapters/GeminiAdapter.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface TreeState {
  tree: DecisionTree;
  tracker: PathTracker;
  name: string;
  loadedAt: string;
}

interface RecordingState {
  recordingId: string;
  taskName: string;
  description: string;
  tree: DecisionTree;
  tracker: PathTracker;
  lastNodeId: string | null;
  nodeCounter: number;
  edgeCounter: number;
  startedAt: string;
}

const trees = new Map<string, TreeState>();
const recordings = new Map<string, RecordingState>();
const serializer = new TreeSerializer();

function getRecording(recordingId: string): RecordingState {
  const state = recordings.get(recordingId);
  if (!state) {
    throw new Error(
      `Recording "${recordingId}" not found. Active recordings: ${[...recordings.keys()].join(', ') || 'none'}`,
    );
  }
  return state;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function getTree(treeId: string): TreeState {
  const state = trees.get(treeId);
  if (!state) {
    throw new Error(
      `Tree "${treeId}" not found. Loaded trees: ${[...trees.keys()].join(', ') || 'none'}`,
    );
  }
  return state;
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'decision-pathfinder',
  version: '1.0.0',
});

// ─── Tool: Start Recording ────────────────────────────────────────────────────

server.registerTool(
  'dp_start_recording',
  {
    title: 'Start Recording a Task',
    description:
      'Begin recording the current task as a decision tree. Call this BEFORE starting a multi-step task so each subsequent action can be captured. Returns a recordingId used with dp_record_step and dp_finalize_recording. Each step you take (tool call, decision, condition check) should be recorded so the tree can guide future executions of similar tasks.',
    inputSchema: {
      taskName: z.string().describe(
        'Short descriptive name for this task (e.g., "deploy-web-app", "fix-auth-bug")',
      ),
      description: z.string().optional().describe(
        'Longer description of what this task accomplishes',
      ),
    },
  },
  async (args) => {
    const recordingId = `rec-${Date.now()}-${slugify(args.taskName)}`;
    const tree = new DecisionTree();

    // Create the root "start" node
    const startNodeId = 'start';
    tree.addNode(
      new ConversationNode(startNodeId, args.taskName, {
        prompt: args.description ?? `Task: ${args.taskName}`,
      }),
    );

    recordings.set(recordingId, {
      recordingId,
      taskName: args.taskName,
      description: args.description ?? '',
      tree,
      tracker: new PathTracker(),
      lastNodeId: startNodeId,
      nodeCounter: 1,
      edgeCounter: 0,
      startedAt: new Date().toISOString(),
    });

    return jsonResponse({
      recordingId,
      startNodeId,
      message: `Recording started. Use dp_record_step to capture each action, then dp_finalize_recording when done.`,
    });
  },
);

// ─── Tool: Record Step ────────────────────────────────────────────────────────

server.registerTool(
  'dp_record_step',
  {
    title: 'Record a Step',
    description:
      'Append a step to the recording. Use this after each meaningful action: tool calls, decisions made, conditions checked. The step is linked linearly to the previous step (use dp_record_branch for multi-way choices). Returns the new nodeId.',
    inputSchema: {
      recordingId: z.string().describe('The recording ID from dp_start_recording'),
      stepType: z.enum(['tool_call', 'conversation', 'conditional']).describe(
        'Type of step: tool_call (you ran a tool), conversation (you made a reasoning decision), conditional (you checked a condition)',
      ),
      label: z.string().describe('Short human-readable label (e.g., "Check git status", "Parse user input")'),
      details: z.record(z.string(), z.unknown()).optional().describe(
        'Step-specific data: for tool_call use { toolName, parameters }; for conversation use { prompt }; for conditional use { condition }',
      ),
      edgeCondition: z.string().optional().describe(
        'Description of WHY this step followed the previous one (the condition/reason). Helps future runs understand the path.',
      ),
    },
  },
  async (args) => {
    try {
      const state = getRecording(args.recordingId);
      const nodeId = `node-${state.nodeCounter++}`;

      let node;
      if (args.stepType === 'tool_call') {
        const details = args.details ?? {};
        node = new ToolCallNode(nodeId, args.label, {
          toolName: (details['toolName'] as string) ?? args.label,
          parameters: (details['parameters'] as Record<string, unknown>) ?? {},
        });
      } else if (args.stepType === 'conditional') {
        const details = args.details ?? {};
        node = new ConditionalNode(nodeId, args.label, {
          condition: (details['condition'] as string) ?? args.label,
        });
      } else {
        const details = args.details ?? {};
        node = new ConversationNode(nodeId, args.label, {
          prompt: (details['prompt'] as string) ?? args.label,
        });
      }

      state.tree.addNode(node);

      // Linear edge from previous step
      if (state.lastNodeId) {
        const edgeId = `edge-${state.edgeCounter++}`;
        state.tree.addEdge({
          id: edgeId,
          sourceId: state.lastNodeId,
          targetId: nodeId,
          metadata: {},
          ...(args.edgeCondition !== undefined
            ? { condition: args.edgeCondition }
            : {}),
        });
      }

      state.lastNodeId = nodeId;

      return jsonResponse({
        recordingId: args.recordingId,
        nodeId,
        stepType: args.stepType,
        totalSteps: state.nodeCounter - 1,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Record Branch ──────────────────────────────────────────────────────

server.registerTool(
  'dp_record_branch',
  {
    title: 'Record a Decision Branch',
    description:
      'Mark that at the previous step you had multiple options and chose one. This enriches the tree with alternatives that were considered, enabling better future recommendations. Provide the edge conditions (labels) for the options NOT taken — they become phantom edges that future runs can explore.',
    inputSchema: {
      recordingId: z.string().describe('The recording ID'),
      chosenCondition: z.string().describe('Description of the option you chose'),
      alternativesConsidered: z.array(z.string()).describe(
        'Descriptions of other options you considered but did not take',
      ),
    },
  },
  async (args) => {
    try {
      const state = getRecording(args.recordingId);
      // Find the most recent edge and update its condition to be the chosen path
      // Then add placeholder nodes for alternatives
      // Simpler approach: just annotate the current node's metadata

      if (!state.lastNodeId) {
        return errorResponse('No steps recorded yet');
      }

      const currentNode = state.tree.getNode(state.lastNodeId);
      if (!currentNode) {
        return errorResponse(`Current node "${state.lastNodeId}" not found`);
      }

      currentNode.metadata['branch'] = {
        chosen: args.chosenCondition,
        alternatives: args.alternativesConsidered,
      };

      return jsonResponse({
        recordingId: args.recordingId,
        nodeId: state.lastNodeId,
        branchRecorded: {
          chosen: args.chosenCondition,
          alternativeCount: args.alternativesConsidered.length,
        },
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Finalize Recording ─────────────────────────────────────────────────

server.registerTool(
  'dp_finalize_recording',
  {
    title: 'Finalize Recording',
    description:
      'End the recording with a success or failure outcome. Optionally save the tree to a file so it can be loaded later and used to guide similar future tasks. The tree is also registered as a loaded tree (use dp_list_trees to see).',
    inputSchema: {
      recordingId: z.string().describe('The recording ID'),
      outcome: z.enum(['success', 'failure']).describe('Final outcome of the task'),
      outcomeMessage: z.string().describe('Description of the final outcome'),
      savePath: z.string().optional().describe(
        'File path to save the tree JSON. If omitted, the tree is kept in memory only.',
      ),
    },
  },
  async (args) => {
    try {
      const state = getRecording(args.recordingId);

      // Add terminal node
      const terminalId = args.outcome;
      if (args.outcome === 'success') {
        state.tree.addNode(
          new SuccessNode(terminalId, 'Success', {
            message: args.outcomeMessage,
          }),
        );
      } else {
        state.tree.addNode(
          new FailureNode(terminalId, 'Failure', {
            message: args.outcomeMessage,
            recoverable: false,
          }),
        );
      }

      // Connect last step to terminal
      if (state.lastNodeId && state.lastNodeId !== terminalId) {
        state.tree.addEdge({
          id: `edge-${state.edgeCounter++}`,
          sourceId: state.lastNodeId,
          targetId: terminalId,
          metadata: {},
        });
      }

      // Register as a loaded tree so it can be executed later
      const treeId = slugify(state.taskName);
      trees.set(treeId, {
        tree: state.tree,
        tracker: state.tracker,
        name: state.taskName,
        loadedAt: new Date().toISOString(),
      });

      let savedPath: string | undefined;
      if (args.savePath) {
        const resolved = path.resolve(args.savePath);
        fs.writeFileSync(resolved, serializer.toJSON(state.tree), 'utf-8');
        savedPath = resolved;
      }

      recordings.delete(args.recordingId);

      return jsonResponse({
        recordingId: args.recordingId,
        treeId,
        outcome: args.outcome,
        nodeCount: state.tree.nodeCount,
        edgeCount: state.tree.edgeCount,
        savedPath,
        message: `Recording finalized. Tree "${treeId}" is now loaded and can be executed with dp_execute_tree.`,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Load Tree ──────────────────────────────────────────────────────────

server.registerTool(
  'dp_load_tree',
  {
    title: 'Load Decision Tree',
    description:
      'Load a decision tree from a JSON file path or inline JSON string. Returns the tree ID for use with other tools.',
    inputSchema: {
      source: z.string().describe(
        'Either a file path to a .json tree definition, or an inline JSON string of a serialized tree',
      ),
      treeId: z.string().optional().describe(
        'Custom ID for this tree. Defaults to filename or "tree-N"',
      ),
    },
  },
  async (args) => {
    let json: string;

    if (args.source.trim().startsWith('{')) {
      json = args.source;
    } else {
      const filePath = path.resolve(args.source);
      if (!fs.existsSync(filePath)) {
        return errorResponse(`File not found: ${filePath}`);
      }
      json = fs.readFileSync(filePath, 'utf-8');
    }

    try {
      const tree = serializer.fromJSON(json);
      const id =
        args.treeId ??
        (args.source.trim().startsWith('{')
          ? `tree-${trees.size + 1}`
          : path.basename(args.source, '.json'));

      trees.set(id, {
        tree,
        tracker: new PathTracker(),
        name: id,
        loadedAt: new Date().toISOString(),
      });

      return jsonResponse({
        treeId: id,
        nodeCount: tree.nodeCount,
        edgeCount: tree.edgeCount,
        rootNodes: tree.getRootNodes().map((n) => ({
          id: n.id,
          type: n.type,
          label: n.label,
        })),
      });
    } catch (err) {
      return errorResponse(`Failed to parse tree: ${(err as Error).message}`);
    }
  },
);

// ─── Tool: List Trees ─────────────────────────────────────────────────────────

server.registerTool(
  'dp_list_trees',
  {
    title: 'List Decision Trees',
    description: 'List all loaded decision trees with their IDs, node counts, and session history.',
  },
  async () => {
    const list = [...trees.entries()].map(([id, state]) => ({
      treeId: id,
      nodeCount: state.tree.nodeCount,
      edgeCount: state.tree.edgeCount,
      sessions: state.tracker.getAllSessions().length,
      loadedAt: state.loadedAt,
    }));
    return jsonResponse(list);
  },
);

// ─── Tool: Execute Tree ───────────────────────────────────────────────────────

server.registerTool(
  'dp_execute_tree',
  {
    title: 'Execute Decision Tree',
    description:
      'Execute a loaded decision tree from a start node. Uses Gemini if GEMINI_API_KEY is set, otherwise uses MockDecisionMaker. Automatically uses recommendation engine if prior executions exist.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      startNodeId: z.string().optional().describe(
        'Node ID to start from. Defaults to first root node.',
      ),
      useRecommendations: z.boolean().optional().describe(
        'Use recommendation engine for guidance. Default: true',
      ),
      maxSteps: z.number().optional().describe(
        'Max execution steps. Default: 50',
      ),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const { tree, tracker } = state;

      const startNodeId = args.startNodeId ?? tree.getRootNodes()[0]?.id;
      if (!startNodeId) {
        return errorResponse('Tree has no root nodes');
      }

      // Build decision maker
      let decisionMaker: IDecisionMaker;
      const apiKey = process.env['GEMINI_API_KEY'];

      if (apiKey) {
        const adapter = new GeminiAdapter({
          apiKey,
          modelName: process.env['GEMINI_MODEL'] ?? 'gemini-2.0-flash-lite',
        });

        if (args.useRecommendations !== false && tracker.getAllSessions().length > 0) {
          const engine = new RecommendationEngine(tree, tracker);
          decisionMaker = {
            async decide(context) {
              const rec = engine.getEdgeRecommendation(context.currentNodeId);
              if (rec && rec.confidence >= 0.6) {
                const valid = context.availableEdges.some((e) => e.id === rec.recommendedEdgeId);
                if (valid) {
                  return {
                    chosenEdgeId: rec.recommendedEdgeId,
                    reasoning: `Override (confidence: ${(rec.confidence * 100).toFixed(0)}%)`,
                  };
                }
              }
              if (rec && rec.confidence >= 0.2) {
                return adapter.decide({
                  ...context,
                  metadata: {
                    ...context.metadata,
                    recommendation: { suggestedEdgeId: rec.recommendedEdgeId, confidence: rec.confidence },
                  },
                });
              }
              return adapter.decide(context);
            },
          };
        } else {
          decisionMaker = adapter;
        }
      } else {
        decisionMaker = new MockDecisionMaker();
      }

      const executor = new TreeExecutor(tree, decisionMaker, tracker, {
        maxSteps: args.maxSteps ?? 50,
      });

      const result = await executor.execute(startNodeId);

      return jsonResponse({
        status: result.status,
        finalNodeId: result.finalNodeId,
        finalNodeLabel: result.finalNode.label,
        stepCount: result.stepCount,
        pathTaken: result.pathTaken,
        variables: result.variables,
        error: result.error,
        totalSessions: tracker.getAllSessions().length,
      });
    } catch (err) {
      return errorResponse(`Execution failed: ${(err as Error).message}`);
    }
  },
);

// ─── Tool: Get Recommendation ─────────────────────────────────────────────────

server.registerTool(
  'dp_get_recommendation',
  {
    title: 'Get Edge Recommendation',
    description:
      'Get the recommended next edge at a node based on historical execution data.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      nodeId: z.string().describe('Node ID to get recommendation for'),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const engine = new RecommendationEngine(state.tree, state.tracker);
      const rec = engine.getEdgeRecommendation(args.nodeId);

      if (!rec) {
        return jsonResponse({
          nodeId: args.nodeId,
          recommendation: null,
          reason: 'No outgoing edges or no history',
        });
      }

      return jsonResponse({
        nodeId: args.nodeId,
        recommendedEdgeId: rec.recommendedEdgeId,
        targetNodeId: rec.targetNodeId,
        confidence: rec.confidence,
        reasoning: rec.reasoning,
        alternatives: rec.alternativeEdges,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Get Analytics ──────────────────────────────────────────────────────

server.registerTool(
  'dp_get_analytics',
  {
    title: 'Get Execution Analytics',
    description:
      'Get execution analytics: success rates, bottlenecks, path analysis, edge recommendations.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const engine = new RecommendationEngine(state.tree, state.tracker);
      const report = engine.generateOptimizationReport();
      const bottlenecks = engine.identifyBottlenecks(0.3);

      const edgeRecs: Record<string, unknown> = {};
      for (const [nodeId, rec] of report.edgeRecommendations) {
        edgeRecs[nodeId] = {
          recommendedEdgeId: rec.recommendedEdgeId,
          confidence: rec.confidence,
          reasoning: rec.reasoning,
        };
      }

      return jsonResponse({
        totalSessions: report.analysis.totalSessions,
        successRate: report.analysis.successRate,
        averagePathLength: report.analysis.averagePathLength,
        mostCommonPath: report.analysis.mostCommonPath,
        mostSuccessfulPath: report.analysis.mostSuccessfulPath,
        bottleneckNodes: bottlenecks.map((b) => ({
          nodeId: b.nodeId,
          visitCount: b.visitCount,
          failureRate: b.visitCount > 0 ? b.failureCount / b.visitCount : 0,
        })),
        edgeRecommendations: edgeRecs,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Export Tree ────────────────────────────────────────────────────────

server.registerTool(
  'dp_export_tree',
  {
    title: 'Export Decision Tree',
    description: 'Export a loaded tree to JSON. Optionally write to a file.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      filePath: z.string().optional().describe('File path to write JSON to'),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const json = serializer.toJSON(state.tree);

      if (args.filePath) {
        const resolved = path.resolve(args.filePath);
        fs.writeFileSync(resolved, json, 'utf-8');
        return jsonResponse({ exported: true, path: resolved, bytes: json.length });
      }

      return { content: [{ type: 'text' as const, text: json }] };
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
