# decision-pathfinder

A decision tree engine for LLM-driven workflows. Define trees with typed nodes, execute them with any LLM, and watch the system get smarter over time through heuristic path caching.

The core idea: instead of letting an LLM freestyle every decision, you define the decision space as a tree. The LLM navigates it. A recommendation engine tracks which paths succeed and which fail. Over repeated runs, high-confidence paths get locked in — the LLM call gets skipped entirely, dropping latency to zero and cost to nothing.

## How it works

```
Run 1:  LLM decides → 602ms, 0% confidence
Run 3:  LLM decides with bias hints → 562ms, 30% confidence
Run 7:  Override (skip LLM) → 0ms, 70% confidence
Run 10: Locked in → 0ms, 100% confidence, zero API calls forever
```

The recommendation engine rebuilds after every execution. Each run feeds back into higher confidence scores, which trigger more overrides, which produce more consistent data. It's a flywheel.

## Install

```bash
npm install decision-pathfinder
```

## Quick start

```typescript
import {
  DecisionTree,
  ConversationNode,
  ToolCallNode,
  SuccessNode,
  FailureNode,
  TreeExecutor,
  MockDecisionMaker,
  PathTracker,
} from 'decision-pathfinder';

// 1. Build a tree
const tree = new DecisionTree();

tree.addNode(new ConversationNode('start', 'Choose path', {
  prompt: 'Pick the best approach for this task.',
}));
tree.addNode(new ToolCallNode('fetch', 'Fetch data', {
  toolName: 'fetchData',
  parameters: { url: 'https://api.example.com' },
}));
tree.addNode(new SuccessNode('done', 'Complete', {
  message: 'Task finished successfully',
}));

tree.addEdge({ id: 'e1', sourceId: 'start', targetId: 'fetch', metadata: {} });
tree.addEdge({ id: 'e2', sourceId: 'fetch', targetId: 'done', metadata: {} });

// 2. Execute with a decision maker
const tracker = new PathTracker();
const executor = new TreeExecutor(
  tree,
  new MockDecisionMaker(), // or GeminiAdapter for real LLM
  tracker,
  {
    toolHandlers: new Map([
      ['fetchData', async (params) => {
        // your actual tool implementation
        return { data: 'result' };
      }],
    ]),
  },
);

const result = await executor.execute('start');
console.log(result.status);    // 'success'
console.log(result.pathTaken); // ['start', 'fetch', 'done']
```

## Using with Gemini

```typescript
import { GeminiAdapter } from 'decision-pathfinder';

const adapter = new GeminiAdapter({
  apiKey: process.env.GEMINI_API_KEY!,
  modelName: 'gemini-2.0-flash-lite', // cheap and fast
});

const executor = new TreeExecutor(tree, adapter, tracker);
const result = await executor.execute('start');
```

## Node types

| Type | Purpose | Key fields |
|------|---------|------------|
| `ConversationNode` | LLM decision point | `prompt`, `expectedResponses`, `systemMessage` |
| `ToolCallNode` | Execute a tool | `toolName`, `parameters`, `timeout`, `retryCount` |
| `ConditionalNode` | Branch on a condition | `condition`, `evaluator`, `trueEdgeId`, `falseEdgeId` |
| `SuccessNode` | Terminal success | `message`, `resultData` |
| `FailureNode` | Terminal failure | `message`, `errorCode`, `recoverable`, `suggestedAction` |

## Recommendation engine

The `RecommendationEngine` analyzes execution history and provides:

- **Edge recommendations** — which edge to take at each branch, with confidence scores
- **Bottleneck detection** — nodes with high failure rates
- **Path analysis** — most common path, most successful path, average length

```typescript
import { RecommendationEngine } from 'decision-pathfinder';

const engine = new RecommendationEngine(tree, tracker);
const rec = engine.getEdgeRecommendation('decision-node-id');
// { recommendedEdgeId: 'e2', confidence: 0.85, reasoning: '...' }

const report = engine.generateOptimizationReport();
// { analysis, bottlenecks, edgeRecommendations }
```

All heuristic-based. No LLM needed for recommendations.

## Serialization

Save and load trees as JSON:

```typescript
import { TreeSerializer } from 'decision-pathfinder';

const serializer = new TreeSerializer();
const json = serializer.toJSON(tree);     // string
const restored = serializer.fromJSON(json); // DecisionTree

// Custom node types
serializer.registerNodeType('custom', (s) => new MyCustomNode(s.id, s.label, s.data));
```

## Benchmark results

The benchmark harness runs 7 scenarios designed to stress-test LLM decision-making, each executed in two phases with iterative learning:

| Scenario | What it tests | Convergence |
|----------|--------------|-------------|
| Ambiguous Routing | 3-way choice from subtle context | 0% → 100% confidence in 7 runs |
| Tool Chain Failures | Unreliable tools with fallbacks | Learns to prefer reliable source |
| Multi-Step Reasoning | Combine 3 clues across 8 steps | 0% → 100% confidence in 7 runs |
| Adversarial Prompts | Double negatives, inverted labels | 5.8s → 0ms per run |
| High Branching | 6-way region selection | 0% → 100% confidence in 7 runs |
| Recovery Paths | Primary endpoint always down | Hardest — needs prompt iteration |
| Speed vs Accuracy | Fast (70% fail) vs careful (5% fail) | Pro/Flash find careful path 5/5 |

Run the benchmark yourself:

```bash
GEMINI_API_KEY=your-key npm run benchmark
```

Cross-model mode tests knowledge transfer — a smarter model (Pro) teaches Flash Lite by establishing successful paths that get cached as overrides.

## MCP Server

decision-pathfinder includes an MCP server so Claude Code, Cursor, and other MCP clients can use decision trees directly.

### Setup

Add to your Claude Code config (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "decision-pathfinder": {
      "command": "npx",
      "args": ["decision-pathfinder-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

Or for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "decision-pathfinder": {
      "command": "npx",
      "args": ["decision-pathfinder-mcp"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

### Available tools

| Tool | Description |
|------|-------------|
| `dp_load_tree` | Load a tree from a JSON file or inline JSON |
| `dp_list_trees` | List all loaded trees |
| `dp_execute_tree` | Execute a tree (uses Gemini + recommendations automatically) |
| `dp_get_recommendation` | Get edge recommendation at a node |
| `dp_get_analytics` | Get execution analytics and bottleneck report |
| `dp_export_tree` | Export a tree to JSON |

The server runs locally on your machine. Trees, history, and recommendations stay local. Set `GEMINI_API_KEY` for LLM-powered decisions, or omit it to use the MockDecisionMaker (picks first available edge).

Set `GEMINI_MODEL` to override the default model (e.g., `gemini-2.5-flash`).

## Scripts

```bash
npm run build      # compile to dist/
npm run test       # 129 tests
npm run lint       # biome check
npm run demo       # tree-driven README generator using Gemini
npm run benchmark  # cross-model benchmark harness
```

## License

ISC
