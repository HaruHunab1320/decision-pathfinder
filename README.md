# decision-pathfinder

A decision tree engine for LLM-driven workflows. Agents follow typed trees instead of freestyling every step. Over repeated runs the system records which paths succeeded, learns which are shortest, and starts skipping the LLM entirely for decisions it has confidently solved before.

The paths **are** the knowledge — no vector DB, no embeddings, no RAG. Just JSON and heuristics.

## How it works

```
Run 1:  LLM decides  → 600ms, 0% confidence
Run 3:  LLM + bias   → 500ms, 30% confidence
Run 7:  Override     → 0ms LLM, 70% confidence
Run 15: Locked in    → 0ms LLM, 100% confidence
```

Three things make the flywheel work:

1. **Efficiency-weighted confidence** — a 3-step successful path ranks higher than a 10-step successful path. Agents naturally discover shortcuts; wasted tool calls get pruned.
2. **Persistent history** — completed sessions go to `~/.decision-pathfinder/sessions/{treeId}.jsonl`. Every process restart picks up where the last one left off.
3. **Confidence-gated override** — above 60% confidence, the LLM call is skipped entirely and the historically-best edge is taken directly. The tool calls still run (they do real work) — only the decision-making LLM call disappears.

## Where LLMs fit in

**The LLM is called in exactly one place: at branch points in a tree.** When the executor reaches a node with multiple outgoing edges, it asks "which edge do I take?" — nothing else uses an LLM.

| Component | LLM used? |
|-----------|-----------|
| RecommendationEngine | No — pure heuristics |
| PathTracker | No — just records |
| TreeExecutor | No — runs tree logic |
| Tool handlers | No — your code runs |
| Conditional evaluators | No — registered functions |
| Decision at branch points | Yes — via `IDecisionMaker` |
| Overridden decisions (high confidence) | No — skipped |

`IDecisionMaker` is an interface. Ships with:
- `GeminiAdapter` — uses Google Gemini (any model)
- `MockDecisionMaker` — picks the first available edge (deterministic, no LLM)
- Your own implementation for OpenAI, Anthropic, local models, etc.

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
  TreeExecutor,
  MockDecisionMaker,
  PathTracker,
} from 'decision-pathfinder';

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

const tracker = new PathTracker();
const executor = new TreeExecutor(
  tree,
  new MockDecisionMaker(),
  tracker,
  {
    toolHandlers: new Map([
      ['fetchData', async (params) => ({ data: 'real result' })],
    ]),
  },
);

const result = await executor.execute('start');
// result.status === 'success'
// result.pathTaken === ['start', 'fetch', 'done']
```

## Using with Gemini

```typescript
import { GeminiAdapter } from 'decision-pathfinder';

const adapter = new GeminiAdapter({
  apiKey: process.env.GEMINI_API_KEY!,
  modelName: 'gemini-2.0-flash-lite',
});

const executor = new TreeExecutor(tree, adapter, tracker);
```

## Persistent learning

Use `PersistentPathTracker` to get cross-session learning automatically:

```typescript
import { SessionStore, PersistentPathTracker } from 'decision-pathfinder';

const store = new SessionStore();                  // ~/.decision-pathfinder/sessions/
const tracker = new PersistentPathTracker(store, 'my-task');
await tracker.initialize();                         // loads all prior sessions

const executor = new TreeExecutor(tree, adapter, tracker);
await executor.execute('start');
// Session appended to my-task.jsonl on endSession()
// Next time this script runs, history is preserved
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

Pure heuristics — no LLM. Analyzes execution history to provide:
- Edge recommendations with efficiency-weighted confidence scores
- Bottleneck detection (nodes with high failure rates)
- Path analysis (most common, most successful, **shortest** successful)

```typescript
import { RecommendationEngine } from 'decision-pathfinder';

const engine = new RecommendationEngine(tree, tracker);
const rec = engine.getEdgeRecommendation('decision-node-id');
// { recommendedEdgeId: 'e2', confidence: 0.85, reasoning: '...' }

const report = engine.generateOptimizationReport();
// { analysis: { shortestSuccessfulPath, ... }, bottlenecks, edgeRecommendations }
```

Confidence formula:
```
confidence = success_rate × sample_factor × efficiency_factor
  sample_factor    = min(samples / 10, 1)
  efficiency_factor = shortest_known / this_path_avg_length
```

## Serialization

```typescript
import { TreeSerializer } from 'decision-pathfinder';

const serializer = new TreeSerializer();
const json = serializer.toJSON(tree);
const restored = serializer.fromJSON(json);

// Custom node types
serializer.registerNodeType('custom', (s) => new MyCustomNode(s.id, s.label, s.data));
```

## MCP Server

decision-pathfinder ships with an MCP server so Claude Code, Cursor, and other MCP clients can use decision trees directly — including recording new trees as the agent works.

### Setup

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

### Two LLMs at once

When you use the MCP server from Claude Code:
- **Claude** is the agent — it calls MCP tools and drives your session
- **Gemini** is used inside `dp_execute_tree` for branch-point decisions

This is an economic choice — Claude is expensive, Gemini Flash Lite is cheap, and tree traversal is a high-volume, low-complexity task. Omit `GEMINI_API_KEY` to fall back to `MockDecisionMaker` (deterministic first-edge picker). Set `GEMINI_MODEL` to pick a different Gemini model (e.g., `gemini-2.5-flash`).

### Available tools

**Recording** — capture sessions as they happen:

| Tool | Description |
|------|-------------|
| `dp_start_recording` | Begin recording a new task |
| `dp_record_step` | Append a step (tool call, decision, condition check) |
| `dp_record_branch` | Mark a decision point with alternatives considered |
| `dp_finalize_recording` | End with success/failure, optionally save to file |

**Playback + analytics**:

| Tool | Description |
|------|-------------|
| `dp_load_tree` | Load a tree from a JSON file or inline JSON |
| `dp_list_trees` | List all loaded trees |
| `dp_get_history_summary` | Show accumulated wisdom for a tree (use BEFORE executing) |
| `dp_execute_tree` | Execute a tree (uses Gemini + recommendations automatically) |
| `dp_get_recommendation` | Get edge recommendation at a node |
| `dp_get_analytics` | Success rates, bottlenecks, path analysis |
| `dp_export_tree` | Export a tree to JSON |

### Example workflow

**First time doing a task** — the LLM records as it goes:

```
dp_start_recording({ taskName: "deploy-staging" }) → recordingId

[Claude does the work, calling tools normally, also calling dp_record_step after each step]

dp_record_step({ stepType: "tool_call", label: "Check git status" })
dp_record_step({ stepType: "tool_call", label: "Run tests" })
dp_record_step({ stepType: "tool_call", label: "Deploy", edgeCondition: "tests passed" })

dp_finalize_recording({
  outcome: "success",
  outcomeMessage: "Deployed to staging",
  savePath: "./trees/deploy-staging.json"
})
```

**Next time** — the LLM loads the tree and executes it:

```
dp_get_history_summary({ treeId: "deploy-staging" })
  → { totalSessions: 8, successRate: 1.0, shortestSuccessfulSteps: 3 }

dp_execute_tree({ treeId: "deploy-staging" })
  → follows the proven path, overrides kick in for familiar decisions
```

Everything runs locally. Trees, history, and recommendations stay on your machine.

## Scripts

```bash
npm run build      # compile to dist/
npm run test       # 151 tests
npm run lint       # biome check
npm run demo       # tree-driven README generator using Gemini
npm run benchmark  # cross-model benchmark harness (flash-lite vs flash vs pro)
```

## Benchmark results

The benchmark harness runs 7 scenarios designed to stress-test LLM decision-making, each executed across multiple teacher models with iterative learning:

| Scenario | What it tests |
|----------|--------------|
| Ambiguous Routing | 3-way choice from subtle context |
| Tool Chain Failures | Unreliable tools with fallbacks |
| Multi-Step Reasoning | Combine 3 clues across 8 steps |
| Adversarial Prompts | Double negatives, inverted labels |
| High Branching | 6-way region selection |
| Recovery Paths | Primary endpoint always down |
| Speed vs Accuracy | Fast (70% fail) vs careful (5% fail) |

The flywheel is observable — e.g., on Ambiguous Routing:
```
Run 1: 602ms, 0% confidence (raw LLM)
Run 7: 0ms,   70% confidence (override kicks in)
Run 15: 0ms, 100% confidence (permanent)
```

Cross-model mode tests knowledge transfer — a smarter teacher (Pro) establishes successful paths that Flash Lite replays at override-level confidence.

## License

ISC
