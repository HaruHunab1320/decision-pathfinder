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
 *     dp_get_history_summary — Show accumulated wisdom for a tree
 *     dp_execute_tree      — Execute a tree (auto-uses recommendations)
 *     dp_get_recommendation — Get edge recommendation at a node
 *     dp_get_analytics     — Get execution analytics and bottleneck report
 *     dp_suggest_edits    — Propose structural improvements from session analysis
 *     dp_start_execution   — Begin agent-driven step-by-step execution
 *     dp_step              — Advance agent-driven execution by choosing an edge
 *     dp_suggest_edits    — Propose structural improvements from session analysis
 *     dp_find_tree         — Search for trees by task description
 *     dp_export_tree       — Export a tree to JSON (optionally with history)
 *     dp_import_tree       — Import a tree (optionally with history)
 *
 * Session persistence: Completed executions are appended to JSONL files at
 * ~/.decision-pathfinder/sessions/{treeId}.jsonl, so recommendations
 * accumulate across process restarts.
 *
 * LLM provider auto-detection (priority order):
 *   1. MCP sampling    → Host LLM (zero-config, no API keys needed)
 *   2. ANTHROPIC_API_KEY → Claude (claude-haiku-4-5)
 *   3. OPENAI_API_KEY    → OpenAI (gpt-4o-mini)
 *   4. GEMINI_API_KEY    → Gemini (gemini-2.0-flash-lite)
 *   5. none              → MockDecisionMaker (picks first edge)
 *
 * Set DP_NO_SAMPLING=1 to skip MCP sampling even if the host supports it.
 *
 * Override model with DP_MODEL (all providers) or provider-specific vars:
 *   ANTHROPIC_MODEL, OPENAI_MODEL, GEMINI_MODEL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ClaudeAdapter } from '../adapters/ClaudeAdapter.js';
import {
  isSamplingAvailable,
  SamplingAdapter,
} from '../adapters/SamplingAdapter.js';
import { GeminiAdapter } from '../adapters/GeminiAdapter.js';
import { OpenAIAdapter } from '../adapters/OpenAIAdapter.js';
import { DecisionTree } from '../core/DecisionTree.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import { MockDecisionMaker, TreeExecutor } from '../execution/TreeExecutor.js';
import { ConditionalNode } from '../nodes/ConditionalNode.js';
import { ConversationNode } from '../nodes/ConversationNode.js';
import { FailureNode } from '../nodes/FailureNode.js';
import { SuccessNode } from '../nodes/SuccessNode.js';
import { ToolCallNode } from '../nodes/ToolCallNode.js';
import type { ISessionStore } from '../persistence/index.js';
import {
  PersistentPathTracker,
  SessionStore,
  TreeIndex,
} from '../persistence/index.js';
import { RecommendationEngine } from '../recommendation/RecommendationEngine.js';
import { TreeEvolution } from '../recommendation/TreeEvolution.js';
import { TreeSerializer } from '../serialization/TreeSerializer.js';
import { PathTracker } from '../tracking/PathTracker.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface TreeState {
  tree: DecisionTree;
  tracker: PathTracker;
  name: string;
  loadedAt: string;
  priorSessions: number;
}

interface RecordingState {
  recordingId: string;
  taskName: string;
  description: string;
  family?: string;
  tags: string[];
  tree: DecisionTree;
  tracker: PathTracker;
  lastNodeId: string | null;
  nodeCounter: number;
  edgeCounter: number;
  startedAt: string;
}

/** State for agent-driven step-by-step execution. */
interface StepExecutionState {
  executionId: string;
  treeId: string;
  tree: DecisionTree;
  tracker: import('../tracking/PathTracker.js').PathTracker;
  currentNodeId: string;
  pathHistory: string[];
  variables: Record<string, unknown>;
  stepCount: number;
  maxSteps: number;
  startedAt: string;
  status: 'active' | 'completed';
}

const trees = new Map<string, TreeState>();
const recordings = new Map<string, RecordingState>();
const stepExecutions = new Map<string, StepExecutionState>();
const serializer = new TreeSerializer();
import { SqliteSessionStore } from '../persistence/SqliteSessionStore.js';

const storeDir = process.env.DECISION_PATHFINDER_STORE || undefined;
const sessionStore: ISessionStore =
  process.env.DP_STORE_BACKEND === 'sqlite'
    ? new SqliteSessionStore(storeDir)
    : new SessionStore(storeDir);
const treeIndex = new TreeIndex(sessionStore.getStoreDir());
// Sampling adapter — initialized after connection if client supports it
let samplingAdapter: SamplingAdapter | null = null;

async function createPersistentTracker(treeId: string): Promise<{
  tracker: PersistentPathTracker;
  priorSessions: number;
}> {
  const tracker = new PersistentPathTracker(sessionStore, treeId);
  await tracker.initialize();
  return { tracker, priorSessions: tracker.getPriorSessionCount() };
}

import type { EnhancedPathRecord } from '../core/interfaces.js';

/**
 * Load sessions from family-sibling trees and return them as flat
 * EnhancedPathRecord[][] suitable for RecommendationEngine.pooledSessions.
 */
async function loadFamilySessions(
  treeId: string,
): Promise<EnhancedPathRecord[][]> {
  const siblingIds = treeIndex.getFamilySiblings(treeId);
  if (siblingIds.length === 0) return [];
  const pooled: EnhancedPathRecord[][] = [];
  for (const sibId of siblingIds) {
    const sessions = await sessionStore.load(sibId);
    for (const s of sessions) {
      if (s.records.length > 0) pooled.push(s.records);
    }
  }
  return pooled;
}

interface SelectedProvider {
  name: 'sampling' | 'claude' | 'openai' | 'gemini' | 'mock';
  adapter: IDecisionMaker;
  modelName?: string;
}

/**
 * Select an LLM provider. Priority:
 *   1. MCP sampling (if host supports it and DP_NO_SAMPLING is not set)
 *   2. ANTHROPIC_API_KEY → Claude
 *   3. OPENAI_API_KEY → OpenAI
 *   4. GEMINI_API_KEY → Gemini
 *   5. Mock (picks first edge)
 *
 * Model can be overridden with DP_MODEL env var (or provider-specific vars).
 */
function selectProvider(): SelectedProvider {
  // Prefer MCP sampling if available — zero-config, no API keys needed
  if (!process.env.DP_NO_SAMPLING && samplingAdapter) {
    return { name: 'sampling', adapter: samplingAdapter, modelName: 'host' };
  }

  const anthropic = process.env.ANTHROPIC_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  const gemini = process.env.GEMINI_API_KEY;
  const override = process.env.DP_MODEL;

  if (anthropic) {
    const modelName =
      override ?? process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
    return {
      name: 'claude',
      adapter: new ClaudeAdapter({ apiKey: anthropic, modelName }),
      modelName,
    };
  }
  if (openai) {
    const modelName = override ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    return {
      name: 'openai',
      adapter: new OpenAIAdapter({ apiKey: openai, modelName }),
      modelName,
    };
  }
  if (gemini) {
    const modelName =
      override ?? process.env.GEMINI_MODEL ?? 'gemini-2.0-flash-lite';
    return {
      name: 'gemini',
      adapter: new GeminiAdapter({ apiKey: gemini, modelName }),
      modelName,
    };
  }
  return { name: 'mock', adapter: new MockDecisionMaker() };
}

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
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(msg: string) {
  return {
    content: [{ type: 'text' as const, text: msg }],
    isError: true as const,
  };
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'decision-pathfinder',
  version: '1.3.0',
});

// ─── Tool: Start Recording ────────────────────────────────────────────────────

server.registerTool(
  'dp_start_recording',
  {
    title: 'Start Recording a Task',
    description:
      'Begin recording the current task as a decision tree. Call this BEFORE starting a multi-step task so each subsequent action can be captured. Returns a recordingId used with dp_record_step and dp_finalize_recording. Each step you take (tool call, decision, condition check) should be recorded so the tree can guide future executions of similar tasks.',
    inputSchema: {
      taskName: z
        .string()
        .describe(
          'Short descriptive name for this task (e.g., "deploy-web-app", "fix-auth-bug")',
        ),
      description: z
        .string()
        .optional()
        .describe('Longer description of what this task accomplishes'),
      family: z
        .string()
        .optional()
        .describe(
          'Family group for this tree (e.g., "deployment"). Trees in the same family share session history for better recommendations.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'Tags for discovery (e.g., ["deploy", "docker", "k8s"]). Used by dp_find_tree.',
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

    const recording: RecordingState = {
      recordingId,
      taskName: args.taskName,
      description: args.description ?? '',
      tags: args.tags ?? [],
      tree,
      tracker: new PathTracker(),
      lastNodeId: startNodeId,
      nodeCounter: 1,
      edgeCounter: 0,
      startedAt: new Date().toISOString(),
    };
    if (args.family !== undefined) recording.family = args.family;
    recordings.set(recordingId, recording);

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
      recordingId: z
        .string()
        .describe('The recording ID from dp_start_recording'),
      stepType: z
        .enum(['tool_call', 'conversation', 'conditional'])
        .describe(
          'Type of step: tool_call (you ran a tool), conversation (you made a reasoning decision), conditional (you checked a condition)',
        ),
      label: z
        .string()
        .describe(
          'Short human-readable label (e.g., "Check git status", "Parse user input")',
        ),
      details: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Step-specific data: for tool_call use { toolName, parameters }; for conversation use { prompt }; for conditional use { condition }',
        ),
      edgeCondition: z
        .string()
        .optional()
        .describe(
          'Description of WHY this step followed the previous one (the condition/reason). Helps future runs understand the path.',
        ),
    },
  },
  async (args) => {
    try {
      const state = getRecording(args.recordingId);
      const nodeId = `node-${state.nodeCounter++}`;

      let node: ToolCallNode | ConditionalNode | ConversationNode;
      if (args.stepType === 'tool_call') {
        const details = args.details ?? {};
        node = new ToolCallNode(nodeId, args.label, {
          toolName: (details.toolName as string) ?? args.label,
          parameters: (details.parameters as Record<string, unknown>) ?? {},
        });
      } else if (args.stepType === 'conditional') {
        const details = args.details ?? {};
        node = new ConditionalNode(nodeId, args.label, {
          condition: (details.condition as string) ?? args.label,
        });
      } else {
        const details = args.details ?? {};
        node = new ConversationNode(nodeId, args.label, {
          prompt: (details.prompt as string) ?? args.label,
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
      chosenCondition: z
        .string()
        .describe('Description of the option you chose'),
      alternativesConsidered: z
        .array(z.string())
        .describe(
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

      currentNode.metadata.branch = {
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
      outcome: z
        .enum(['success', 'failure'])
        .describe('Final outcome of the task'),
      outcomeMessage: z.string().describe('Description of the final outcome'),
      savePath: z
        .string()
        .optional()
        .describe(
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

      // Attach metadata to the tree
      state.tree.metadata = {
        taskName: state.taskName,
        createdAt: state.startedAt,
      };
      if (state.family !== undefined)
        state.tree.metadata.family = state.family;
      if (state.tags.length > 0) state.tree.metadata.tags = state.tags;
      if (state.description) state.tree.metadata.description = state.description;

      // Register as a loaded tree so it can be executed later.
      // Swap in a PersistentPathTracker seeded with any prior history for this treeId.
      const treeId = slugify(state.taskName);
      const { tracker, priorSessions } = await createPersistentTracker(treeId);
      trees.set(treeId, {
        tree: state.tree,
        tracker,
        name: state.taskName,
        loadedAt: new Date().toISOString(),
        priorSessions,
      });

      // Update the tree index for discovery
      const indexEntry: Parameters<typeof treeIndex.upsert>[0] = {
        treeId,
        tags: state.tags,
        taskName: state.taskName,
        sessionCount: priorSessions,
        lastUsed: new Date().toISOString(),
        createdAt: state.startedAt,
      };
      if (state.family !== undefined) indexEntry.family = state.family;
      if (state.description) indexEntry.description = state.description;
      await treeIndex.upsert(indexEntry);

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
        family: state.family,
        tags: state.tags,
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
      source: z
        .string()
        .describe(
          'Either a file path to a .json tree definition, or an inline JSON string of a serialized tree',
        ),
      treeId: z
        .string()
        .optional()
        .describe('Custom ID for this tree. Defaults to filename or "tree-N"'),
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

      const { tracker, priorSessions } = await createPersistentTracker(id);
      trees.set(id, {
        tree,
        tracker,
        name: id,
        loadedAt: new Date().toISOString(),
        priorSessions,
      });

      // Update the tree index for discovery
      const meta = tree.metadata;
      const loadIndexEntry: Parameters<typeof treeIndex.upsert>[0] = {
        treeId: id,
        tags: meta.tags ?? [],
        taskName: meta.taskName ?? id,
        sessionCount: priorSessions,
        lastUsed: new Date().toISOString(),
      };
      if (meta.family !== undefined) loadIndexEntry.family = meta.family;
      if (meta.description !== undefined)
        loadIndexEntry.description = meta.description;
      if (meta.createdAt !== undefined)
        loadIndexEntry.createdAt = meta.createdAt;
      if (!args.source.trim().startsWith('{'))
        loadIndexEntry.treePath = path.resolve(args.source);
      await treeIndex.upsert(loadIndexEntry);

      return jsonResponse({
        treeId: id,
        family: meta.family,
        tags: meta.tags,
        nodeCount: tree.nodeCount,
        edgeCount: tree.edgeCount,
        priorSessions,
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
    description:
      'List all loaded decision trees with their IDs, node counts, and how many sessions of history the system has accumulated.',
  },
  async () => {
    const list = [...trees.entries()].map(([id, state]) => ({
      treeId: id,
      family: state.tree.metadata.family,
      tags: state.tree.metadata.tags,
      nodeCount: state.tree.nodeCount,
      edgeCount: state.tree.edgeCount,
      totalSessions: state.tracker.getAllSessions().length,
      loadedAt: state.loadedAt,
    }));
    return jsonResponse(list);
  },
);

// ─── Tool: History Summary ────────────────────────────────────────────────────

server.registerTool(
  'dp_get_history_summary',
  {
    title: 'Get History Summary',
    description:
      'Show how much accumulated wisdom the system has for a given tree: session count, success rate, and shortest known successful path. Use this BEFORE executing a task to know whether prior experience is available. Also works for treeIds that have never been loaded — it checks the persistent store directly.',
    inputSchema: {
      treeId: z.string().describe('The tree ID to check history for'),
    },
  },
  async (args) => {
    try {
      const persisted = await sessionStore.load(args.treeId);
      const loaded = trees.get(args.treeId);

      if (persisted.length === 0 && !loaded) {
        return jsonResponse({
          treeId: args.treeId,
          hasHistory: false,
          message:
            'No prior sessions for this tree. This will be the first run.',
        });
      }

      const successCount = persisted.filter(
        (s) => s.finalStatus === 'success',
      ).length;
      const failureCount = persisted.filter(
        (s) =>
          s.finalStatus === 'failure' ||
          s.finalStatus === 'error' ||
          s.finalStatus === 'max_steps_exceeded',
      ).length;
      const successLengths = persisted
        .filter((s) => s.finalStatus === 'success')
        .map((s) => s.stepCount);
      const shortestSuccess =
        successLengths.length > 0 ? Math.min(...successLengths) : null;
      const avgSuccess =
        successLengths.length > 0
          ? successLengths.reduce((a, b) => a + b, 0) / successLengths.length
          : null;

      // Extract failure reasons (deduplicated, most common first)
      const failureReasonCounts = new Map<string, number>();
      for (const s of persisted) {
        if (s.failureReason) {
          failureReasonCounts.set(
            s.failureReason,
            (failureReasonCounts.get(s.failureReason) ?? 0) + 1,
          );
        }
      }
      const topFailureReasons = [...failureReasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

      return jsonResponse({
        treeId: args.treeId,
        hasHistory: persisted.length > 0,
        loaded: loaded !== undefined,
        totalSessions: persisted.length,
        successCount,
        failureCount,
        successRate: persisted.length > 0 ? successCount / persisted.length : 0,
        shortestSuccessfulSteps: shortestSuccess,
        averageSuccessfulSteps: avgSuccess,
        topFailureReasons,
        mostRecentSession:
          persisted.length > 0
            ? persisted[persisted.length - 1]!.timestamp
            : null,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Execute Tree ───────────────────────────────────────────────────────

server.registerTool(
  'dp_execute_tree',
  {
    title: 'Execute Decision Tree',
    description:
      'Execute a loaded decision tree from a start node. Auto-selects an LLM provider based on available env vars (ANTHROPIC_API_KEY > OPENAI_API_KEY > GEMINI_API_KEY > mock). Automatically uses the recommendation engine if prior executions exist.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      startNodeId: z
        .string()
        .optional()
        .describe('Node ID to start from. Defaults to first root node.'),
      useRecommendations: z
        .boolean()
        .optional()
        .describe('Use recommendation engine for guidance. Default: true'),
      maxSteps: z
        .number()
        .optional()
        .describe('Max execution steps. Default: 50'),
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

      // Auto-select provider + wrap in recommendation-guided decision maker
      const provider = selectProvider();
      let decisionMaker: IDecisionMaker = provider.adapter;

      // Pool family-sibling sessions for cross-tree recommendations
      const familySessions = await loadFamilySessions(args.treeId);
      const hasSessions =
        tracker.getAllSessions().length > 0 || familySessions.length > 0;

      if (
        provider.name !== 'mock' &&
        args.useRecommendations !== false &&
        hasSessions
      ) {
        const engine = new RecommendationEngine(tree, tracker);
        engine.pooledSessions = familySessions;
        const inner = provider.adapter;
        decisionMaker = {
          async decide(context) {
            const rec = engine.getEdgeRecommendation(context.currentNodeId);
            if (rec && rec.confidence >= 0.6) {
              const valid = context.availableEdges.some(
                (e) => e.id === rec.recommendedEdgeId,
              );
              if (valid) {
                return {
                  chosenEdgeId: rec.recommendedEdgeId,
                  reasoning: `Override (confidence: ${(rec.confidence * 100).toFixed(0)}%)`,
                };
              }
            }
            if (rec && rec.confidence >= 0.2) {
              return inner.decide({
                ...context,
                metadata: {
                  ...context.metadata,
                  recommendation: {
                    suggestedEdgeId: rec.recommendedEdgeId,
                    confidence: rec.confidence,
                  },
                },
              });
            }
            return inner.decide(context);
          },
        };
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
        familySessionsPooled: familySessions.length,
        provider: provider.name,
        model: provider.modelName,
        llmCallCount: result.llmCallCount,
        totalTokenUsage: result.totalTokenUsage,
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
      engine.pooledSessions = await loadFamilySessions(args.treeId);
      const rec = engine.getEdgeRecommendation(args.nodeId);

      if (!rec) {
        return jsonResponse({
          nodeId: args.nodeId,
          recommendation: null,
          reason: 'No outgoing edges or no history',
        });
      }

      const siblingCount = treeIndex.getFamilySiblings(args.treeId).length;
      return jsonResponse({
        nodeId: args.nodeId,
        recommendedEdgeId: rec.recommendedEdgeId,
        targetNodeId: rec.targetNodeId,
        confidence: rec.confidence,
        reasoning: rec.reasoning,
        alternatives: rec.alternativeEdges,
        familyPooled: siblingCount > 0,
        familySiblings: siblingCount,
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
      engine.pooledSessions = await loadFamilySessions(args.treeId);
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

// ─── Tool: Suggest Edits ─────────────────────────────────────────────────────

server.registerTool(
  'dp_suggest_edits',
  {
    title: 'Suggest Tree Edits',
    description:
      'Analyze session history and propose structural improvements to the tree. Finds skippable nodes, shortcut opportunities, bottlenecks, and edge reordering suggestions.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      minConfidence: z
        .number()
        .optional()
        .describe(
          'Minimum confidence threshold for suggestions (0-1). Default: 0.5',
        ),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const evolution = new TreeEvolution(state.tree, state.tracker);
      evolution.setPooledSessions(await loadFamilySessions(args.treeId));
      const allSuggestions = evolution.analyze();

      const minConf = args.minConfidence ?? 0.5;
      const filtered = allSuggestions.filter((s) => s.confidence >= minConf);

      if (filtered.length === 0) {
        return jsonResponse({
          treeId: args.treeId,
          suggestions: [],
          message:
            allSuggestions.length > 0
              ? `Found ${allSuggestions.length} suggestion(s) but none above confidence ${minConf}. Lower minConfidence to see them.`
              : 'No suggestions yet — need more session history.',
        });
      }

      return jsonResponse({
        treeId: args.treeId,
        suggestions: filtered.map((s) => ({
          type: s.type,
          nodeId: s.nodeId,
          fromNodeId: s.fromNodeId,
          toNodeId: s.toNodeId,
          confidence: s.confidence,
          reasoning: s.reasoning,
          evidence: s.evidence,
        })),
        message: `Found ${filtered.length} suggestion(s) for improving tree "${args.treeId}".`,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Find Tree ─────────────────────────────────────────────────────────

server.registerTool(
  'dp_find_tree',
  {
    title: 'Find Decision Tree',
    description:
      'Search for the best decision tree to use for a given task. Ranks trees by tag, name, and description relevance. Returns top matches with scores and match reasons. Use this BEFORE dp_load_tree when you know what task you want to accomplish but not which tree to use.',
    inputSchema: {
      taskDescription: z
        .string()
        .describe(
          'Describe the task you want to accomplish (e.g., "deploy the background worker service")',
        ),
      family: z
        .string()
        .optional()
        .describe('Optionally filter to a specific family'),
      limit: z
        .number()
        .optional()
        .describe('Max results to return. Default: 5'),
    },
  },
  async (args) => {
    try {
      let results = treeIndex.search(args.taskDescription, args.limit ?? 5);

      if (args.family !== undefined) {
        results = results.filter((r) => r.family === args.family);
      }

      if (results.length === 0) {
        return jsonResponse({
          matches: [],
          message:
            'No matching trees found. Use dp_start_recording to create a new tree for this task.',
        });
      }

      return jsonResponse({
        matches: results.map((r) => ({
          treeId: r.treeId,
          family: r.family,
          tags: r.tags,
          taskName: r.taskName,
          description: r.description,
          sessionCount: r.sessionCount,
          lastUsed: r.lastUsed,
          treePath: r.treePath,
          score: r.score,
          matchReasons: r.matchReasons,
        })),
        message: `Found ${results.length} matching tree(s). Use dp_load_tree with the treeId or treePath to load one.`,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Start Execution (Agent-Driven) ────────────────────────────────────

server.registerTool(
  'dp_start_execution',
  {
    title: 'Start Agent-Driven Execution',
    description:
      'Start a step-by-step tree execution where YOU (the calling agent) make every decision. No LLM is called internally. Returns the first decision context. Use dp_step to advance.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      startNodeId: z
        .string()
        .optional()
        .describe('Node ID to start from. Defaults to first root node.'),
      maxSteps: z.number().optional().describe('Max steps. Default: 50'),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);
      const { tree, tracker } = state;
      const startNodeId = args.startNodeId ?? tree.getRootNodes()[0]?.id;
      if (!startNodeId) return errorResponse('Tree has no root nodes');

      const node = tree.getNode(startNodeId);
      if (!node) return errorResponse(`Node "${startNodeId}" not found`);

      const executionId = `exec-${Date.now()}-${slugify(args.treeId)}`;
      tracker.startSession();

      const execState: StepExecutionState = {
        executionId,
        treeId: args.treeId,
        tree,
        tracker,
        currentNodeId: startNodeId,
        pathHistory: [startNodeId],
        variables: {},
        stepCount: 0,
        maxSteps: args.maxSteps ?? 50,
        startedAt: new Date().toISOString(),
        status: 'active',
      };
      stepExecutions.set(executionId, execState);

      // Check if terminal
      if (node.type === 'success' || node.type === 'failure') {
        tracker.recordEnhancedVisit(
          node.id,
          node.type === 'success' ? 'success' : 'failure',
        );
        tracker.endSession();
        execState.status = 'completed';
        return jsonResponse({
          executionId,
          status: node.type,
          finalNode: { id: node.id, type: node.type, label: node.label },
          pathTaken: execState.pathHistory,
          stepCount: 0,
        });
      }

      // Return decision context
      const outgoing = tree.getOutgoingEdges(startNodeId);
      const recommendation = tracker.getAllSessions().length > 0
        ? new RecommendationEngine(tree, tracker).getEdgeRecommendation(startNodeId)
        : null;

      return jsonResponse({
        executionId,
        status: 'awaiting_decision',
        currentNode: { id: node.id, type: node.type, label: node.label },
        availableEdges: outgoing.map((e) => ({
          edgeId: e.id,
          targetNodeId: e.targetId,
          targetLabel: tree.getNode(e.targetId)?.label,
          condition: e.condition,
        })),
        recommendation: recommendation
          ? {
              edgeId: recommendation.recommendedEdgeId,
              confidence: recommendation.confidence,
              reasoning: recommendation.reasoning,
            }
          : null,
        pathHistory: execState.pathHistory,
        stepCount: 0,
      });
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Step (Agent-Driven) ───────────────────────────────────────────────

server.registerTool(
  'dp_step',
  {
    title: 'Advance Agent-Driven Execution',
    description:
      'Advance a step-by-step execution by choosing an edge. Returns the next decision context, or the final result if a terminal node is reached.',
    inputSchema: {
      executionId: z.string().describe('The execution ID from dp_start_execution'),
      chosenEdgeId: z.string().describe('The edge ID you chose to follow'),
    },
  },
  async (args) => {
    try {
      const state = stepExecutions.get(args.executionId);
      if (!state) {
        return errorResponse(
          `Execution "${args.executionId}" not found. Active: ${[...stepExecutions.keys()].join(', ') || 'none'}`,
        );
      }
      if (state.status !== 'active') {
        return errorResponse(`Execution "${args.executionId}" is already completed.`);
      }
      if (state.stepCount >= state.maxSteps) {
        state.tracker.endSession();
        state.status = 'completed';
        return jsonResponse({
          executionId: args.executionId,
          status: 'max_steps_exceeded',
          pathTaken: state.pathHistory,
          stepCount: state.stepCount,
        });
      }

      // Validate edge
      const outgoing = state.tree.getOutgoingEdges(state.currentNodeId);
      const edge = outgoing.find((e) => e.id === args.chosenEdgeId);
      if (!edge) {
        return errorResponse(
          `Invalid edge "${args.chosenEdgeId}". Valid: ${outgoing.map((e) => e.id).join(', ')}`,
        );
      }

      // Record current node visit
      state.tracker.recordEnhancedVisit(state.currentNodeId, 'success');
      state.stepCount++;
      state.currentNodeId = edge.targetId;
      state.pathHistory.push(edge.targetId);

      const nextNode = state.tree.getNode(edge.targetId);
      if (!nextNode) {
        return errorResponse(`Target node "${edge.targetId}" not found`);
      }

      // Process tool_call nodes automatically
      if (nextNode.type === 'tool_call') {
        // Tool results go into variables but agent still decides next edge
        const data = (nextNode as any).data as {
          toolName: string;
          parameters: Record<string, unknown>;
        };
        state.variables[`tool_${data.toolName}`] = {
          note: 'Tool execution skipped in agent-driven mode',
        };
      }

      // Terminal check
      if (nextNode.type === 'success' || nextNode.type === 'failure') {
        state.tracker.recordEnhancedVisit(
          nextNode.id,
          nextNode.type === 'success' ? 'success' : 'failure',
        );
        state.tracker.endSession();
        state.status = 'completed';
        return jsonResponse({
          executionId: args.executionId,
          status: nextNode.type,
          finalNode: {
            id: nextNode.id,
            type: nextNode.type,
            label: nextNode.label,
          },
          pathTaken: state.pathHistory,
          stepCount: state.stepCount,
          variables: state.variables,
        });
      }

      // Return next decision context
      const nextOutgoing = state.tree.getOutgoingEdges(edge.targetId);

      // If single outgoing edge, auto-advance
      if (nextOutgoing.length === 1) {
        // Recurse with the single edge
        const singleEdge = nextOutgoing[0]!;
        return jsonResponse({
          executionId: args.executionId,
          status: 'auto_advanced',
          currentNode: {
            id: nextNode.id,
            type: nextNode.type,
            label: nextNode.label,
          },
          autoFollowedEdge: singleEdge.id,
          message: `Single outgoing edge — auto-advanced. Call dp_step again with edge "${singleEdge.id}" to continue, or it was followed automatically.`,
          availableEdges: [{
            edgeId: singleEdge.id,
            targetNodeId: singleEdge.targetId,
            targetLabel: state.tree.getNode(singleEdge.targetId)?.label,
            condition: singleEdge.condition,
          }],
          pathHistory: state.pathHistory,
          stepCount: state.stepCount,
        });
      }

      const recommendation = state.tracker.getAllSessions().length > 0
        ? new RecommendationEngine(state.tree, state.tracker).getEdgeRecommendation(edge.targetId)
        : null;

      return jsonResponse({
        executionId: args.executionId,
        status: 'awaiting_decision',
        currentNode: {
          id: nextNode.id,
          type: nextNode.type,
          label: nextNode.label,
        },
        availableEdges: nextOutgoing.map((e) => ({
          edgeId: e.id,
          targetNodeId: e.targetId,
          targetLabel: state.tree.getNode(e.targetId)?.label,
          condition: e.condition,
        })),
        recommendation: recommendation
          ? {
              edgeId: recommendation.recommendedEdgeId,
              confidence: recommendation.confidence,
              reasoning: recommendation.reasoning,
            }
          : null,
        pathHistory: state.pathHistory,
        stepCount: state.stepCount,
        variables: state.variables,
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
    description:
      'Export a loaded tree to JSON. Set includeHistory to bundle session history for teammate onboarding. Optionally write to a file.',
    inputSchema: {
      treeId: z.string().describe('ID of the loaded tree'),
      filePath: z.string().optional().describe('File path to write JSON to'),
      includeHistory: z
        .boolean()
        .optional()
        .describe(
          'Include session history in the export. Creates a bundle with tree + sessions. Default: false',
        ),
    },
  },
  async (args) => {
    try {
      const state = getTree(args.treeId);

      let output: unknown;
      if (args.includeHistory) {
        const sessions = await sessionStore.load(args.treeId);
        const compactionSummary =
          await sessionStore.getCompactionSummary(args.treeId);
        output = {
          bundle: true,
          version: 1,
          treeId: args.treeId,
          tree: serializer.serialize(state.tree),
          sessions,
          compactionSummary,
          exportedAt: new Date().toISOString(),
        };
      } else {
        output = serializer.serialize(state.tree);
      }

      const json = JSON.stringify(output, null, 2);

      if (args.filePath) {
        const resolved = path.resolve(args.filePath);
        fs.writeFileSync(resolved, json, 'utf-8');
        return jsonResponse({
          exported: true,
          bundled: args.includeHistory ?? false,
          path: resolved,
          bytes: json.length,
          sessionCount: args.includeHistory
            ? (await sessionStore.count(args.treeId))
            : 0,
        });
      }

      return { content: [{ type: 'text' as const, text: json }] };
    } catch (err) {
      return errorResponse((err as Error).message);
    }
  },
);

// ─── Tool: Import Tree ───────────────────────────────────────────────────────

server.registerTool(
  'dp_import_tree',
  {
    title: 'Import Decision Tree',
    description:
      'Import a decision tree from a bundle (exported with includeHistory) or plain tree JSON. Restores the tree, its metadata, and optionally its session history. Use this to onboard from a teammate\'s export.',
    inputSchema: {
      source: z
        .string()
        .describe(
          'File path to a .json export or inline JSON string',
        ),
      treeId: z
        .string()
        .optional()
        .describe(
          'Custom ID for the imported tree. Defaults to the bundled treeId or filename.',
        ),
      importHistory: z
        .boolean()
        .optional()
        .describe(
          'Whether to import session history from a bundle. Default: true',
        ),
    },
  },
  async (args) => {
    try {
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

      const parsed = JSON.parse(json) as Record<string, unknown>;
      const isBundle = parsed.bundle === true;

      let tree: import('../core/DecisionTree.js').DecisionTree;
      let importedSessions = 0;
      let treeId: string;

      if (isBundle) {
        // Bundle format: { bundle: true, tree, sessions, treeId }
        const bundleTree = parsed.tree as import('../serialization/TreeSerializer.js').SerializedTree;
        tree = serializer.deserialize(bundleTree);
        treeId =
          args.treeId ??
          (parsed.treeId as string) ??
          `imported-${trees.size + 1}`;

        if (args.importHistory !== false && Array.isArray(parsed.sessions)) {
          const sessions =
            parsed.sessions as import('../persistence/SessionStore.js').PersistedSession[];
          for (const session of sessions) {
            await sessionStore.append(treeId, session);
          }
          importedSessions = sessions.length;
        }
      } else {
        // Plain tree JSON
        tree = serializer.deserialize(
          parsed as unknown as import('../serialization/TreeSerializer.js').SerializedTree,
        );
        treeId =
          args.treeId ??
          (args.source.trim().startsWith('{')
            ? `imported-${trees.size + 1}`
            : path.basename(args.source, '.json'));
      }

      const { tracker, priorSessions } = await createPersistentTracker(treeId);
      trees.set(treeId, {
        tree,
        tracker,
        name: tree.metadata.taskName ?? treeId,
        loadedAt: new Date().toISOString(),
        priorSessions,
      });

      // Update tree index
      const meta = tree.metadata;
      const importIndexEntry: Parameters<typeof treeIndex.upsert>[0] = {
        treeId,
        tags: meta.tags ?? [],
        taskName: meta.taskName ?? treeId,
        sessionCount: priorSessions,
        lastUsed: new Date().toISOString(),
      };
      if (meta.family !== undefined) importIndexEntry.family = meta.family;
      if (meta.description !== undefined)
        importIndexEntry.description = meta.description;
      if (meta.createdAt !== undefined)
        importIndexEntry.createdAt = meta.createdAt;
      if (!args.source.trim().startsWith('{'))
        importIndexEntry.treePath = path.resolve(args.source);
      await treeIndex.upsert(importIndexEntry);

      return jsonResponse({
        treeId,
        family: meta.family,
        tags: meta.tags,
        nodeCount: tree.nodeCount,
        edgeCount: tree.edgeCount,
        importedSessions,
        totalSessions: priorSessions,
        message: `Tree "${treeId}" imported${importedSessions > 0 ? ` with ${importedSessions} session(s) of history` : ''}. Ready for execution.`,
      });
    } catch (err) {
      return errorResponse(`Import failed: ${(err as Error).message}`);
    }
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Check if the connected client supports sampling
if (isSamplingAvailable(server.server)) {
  samplingAdapter = new SamplingAdapter(server.server);
}
