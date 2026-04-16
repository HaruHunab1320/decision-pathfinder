#!/usr/bin/env node
/**
 * decision-pathfinder MCP server
 *
 * Exposes decision tree operations as MCP tools for Claude Code, Cursor, etc.
 * Runs locally on the user's machine via stdio transport.
 *
 * Tools:
 *   dp_load_tree       — Load a tree from a JSON file or inline JSON
 *   dp_list_trees      — List all loaded trees
 *   dp_execute_tree    — Execute a tree with optional tool handlers
 *   dp_get_recommendation — Get edge recommendation at a node
 *   dp_get_analytics   — Get execution analytics and bottleneck report
 *   dp_export_tree     — Export a tree to JSON
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
import type { IDecisionMaker } from '../execution/TreeExecutor.js';

// ─── State ────────────────────────────────────────────────────────────────────

interface TreeState {
  tree: DecisionTree;
  tracker: PathTracker;
  name: string;
  loadedAt: string;
}

const trees = new Map<string, TreeState>();
const serializer = new TreeSerializer();

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
