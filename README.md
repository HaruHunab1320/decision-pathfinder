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

Four things make the flywheel work:

1. **Efficiency-weighted confidence** — a 3-step successful path ranks higher than a 10-step successful path. Agents naturally discover shortcuts; wasted tool calls get pruned.
2. **Persistent history** — completed sessions go to `~/.decision-pathfinder/sessions/{treeId}.jsonl`. Every process restart picks up where the last one left off. Auto-compaction keeps files fast past 1000 sessions.
3. **Confidence-gated override** — above 60% confidence, the LLM call is skipped entirely and the historically-best edge is taken directly. The tool calls still run (they do real work) — only the decision-making LLM call disappears.
4. **Task families** — sibling trees (e.g. `deploy-web-app`, `deploy-api-app`) share a family. A brand-new tree inherits recommendations from experienced siblings at shared decision points — no cold start.

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
- `SamplingAdapter` — MCP sampling (zero-config, host LLM handles it)
- `ClaudeAdapter` — Anthropic Claude (defaults to `claude-haiku-4-5`)
- `OpenAIAdapter` — OpenAI (defaults to `gpt-4o-mini`)
- `GeminiAdapter` — Google Gemini (defaults to `gemini-2.0-flash-lite`)
- `MockDecisionMaker` — picks the first available edge (deterministic, no LLM)
- Your own implementation for local models or other providers.

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

## LLM providers

Pick whichever provider matches the key you already have:

```typescript
import { ClaudeAdapter, OpenAIAdapter, GeminiAdapter } from 'decision-pathfinder';

// Anthropic — cheap and fast decisions
const claude = new ClaudeAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  modelName: 'claude-haiku-4-5',  // default
});

// OpenAI
const openai = new OpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  modelName: 'gpt-4o-mini',  // default
});

// Gemini
const gemini = new GeminiAdapter({
  apiKey: process.env.GEMINI_API_KEY!,
  modelName: 'gemini-2.0-flash-lite',  // default
});

const executor = new TreeExecutor(tree, claude, tracker);
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

### Session compaction

When history grows large, compact to keep files fast:

```typescript
const store = new SessionStore(undefined, {
  maxSessionsPerTree: 1000,  // trigger auto-compaction above this
  retainRecent: 200,         // keep the 200 most recent sessions
});

// Manual compaction
const { dropped, summary } = await store.compact('my-task');
// Compaction summary persisted to my-task.compaction.json

// Or auto-compact on load
const { sessions, compacted } = await store.loadWithAutoCompact('my-task');
```

### Multi-process safety

All session writes use advisory file locking — safe for multiple MCP server processes on one machine:

```typescript
import { withLock } from 'decision-pathfinder';

await withLock('/path/to/file', async () => {
  // exclusive access
});
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
- **Confidence decay** — older sessions contribute less so recommendations stay fresh
- **Tree evolution** — proposes structural edits (remove skipped nodes, add shortcuts, flag bottlenecks)

```typescript
import { RecommendationEngine, TreeEvolution } from 'decision-pathfinder';

const engine = new RecommendationEngine(tree, tracker, {
  decayHalfLifeDays: 30,  // sessions 30 days old contribute 50%
});
const rec = engine.getEdgeRecommendation('decision-node-id');
// { recommendedEdgeId: 'e2', confidence: 0.85, reasoning: '...' }

// Inject family-sibling sessions for cross-tree learning
engine.pooledSessions = siblingSessionRecords;

const report = engine.generateOptimizationReport();
// { analysis: { shortestSuccessfulPath, ... }, bottlenecks, edgeRecommendations }

// Tree evolution — propose structural improvements
const evolution = new TreeEvolution(tree, tracker);
const suggestions = evolution.analyze();
// [{ type: 'remove_node', nodeId: 'n3', confidence: 0.92,
//    reasoning: '92% of successful sessions skip node "Check cache"' }]
```

Confidence formula:
```
confidence = weighted_success_rate × sample_factor × efficiency_factor
  session_weight   = exp(-age_days × ln2 / halfLife)     # recent sessions count more
  sample_factor    = min(weighted_samples / 10, 1)
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

For most users, this is the entire config — no env block needed. The MCP server inherits env vars from its parent process, so any API key you already have exported (e.g. `ANTHROPIC_API_KEY` from your shell) gets picked up automatically:

```json
{
  "mcpServers": {
    "decision-pathfinder": {
      "command": "npx",
      "args": ["decision-pathfinder-mcp"]
    }
  }
}
```

If you want to pin a specific provider or key:

```json
{
  "mcpServers": {
    "decision-pathfinder": {
      "command": "npx",
      "args": ["decision-pathfinder-mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "ANTHROPIC_MODEL": "claude-haiku-4-5"
      }
    }
  }
}
```

### Provider auto-detection

The server picks a provider in priority order:

| Priority | Source | Provider | Default model |
|----------|--------|----------|---------------|
| 1 | MCP sampling | Host LLM | (host decides) |
| 2 | `ANTHROPIC_API_KEY` | Claude | `claude-haiku-4-5` |
| 3 | `OPENAI_API_KEY` | OpenAI | `gpt-4o-mini` |
| 4 | `GEMINI_API_KEY` | Gemini | `gemini-2.0-flash-lite` |
| 5 | (none) | Mock (picks first edge) | — |

MCP sampling is zero-config — the host LLM (Claude, Cursor, etc.) handles the call, no API keys needed. Set `DP_NO_SAMPLING=1` to skip it.

Override the model per-provider (`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`) or globally (`DP_MODEL`).

### Two LLMs at once

When you use the MCP server from Claude Code:
- **Claude** is the agent — it calls MCP tools and drives your session
- **The auto-detected provider** is used inside `dp_execute_tree` for branch-point decisions

This is an economic choice — the calling agent is typically powerful/expensive, but tree traversal is a high-volume low-complexity task where a cheap/fast model is plenty. If the user is already on Anthropic, Claude Haiku handles branch decisions for pennies. Same key, right-sized model.

When the host supports MCP sampling, the server uses `sampling/createMessage` to delegate decisions to the host's LLM — zero env vars needed.

### Available tools

**Recording** — capture sessions as they happen:

| Tool | Description |
|------|-------------|
| `dp_start_recording` | Begin recording a new task (with optional `family`, `tags`) |
| `dp_record_step` | Append a step (tool call, decision, condition check) |
| `dp_record_branch` | Mark a decision point with alternatives considered |
| `dp_finalize_recording` | End with success/failure, optionally save to file |

**Playback + analytics**:

| Tool | Description |
|------|-------------|
| `dp_load_tree` | Load a tree from a JSON file or inline JSON |
| `dp_list_trees` | List all loaded trees (with family + tags) |
| `dp_find_tree` | Search for trees by task description (keyword/tag ranking) |
| `dp_get_history_summary` | Show accumulated wisdom + top failure reasons |
| `dp_execute_tree` | Execute a tree (uses recommendations + family pooling) |
| `dp_get_recommendation` | Get edge recommendation at a node |
| `dp_get_analytics` | Success rates, bottlenecks, path analysis |
| `dp_suggest_edits` | Propose structural tree improvements from session patterns |
| `dp_export_tree` | Export a tree to JSON (optionally with session history) |
| `dp_import_tree` | Import a tree bundle (with optional session history) |

**Agent-driven execution** — you make every decision:

| Tool | Description |
|------|-------------|
| `dp_start_execution` | Begin step-by-step execution (no internal LLM) |
| `dp_step` | Advance by choosing an edge; returns next decision context |

### Example workflow

**First time doing a task** — the LLM records as it goes:

```
dp_start_recording({
  taskName: "deploy-staging",
  family: "deployment",
  tags: ["deploy", "staging", "docker"]
}) → recordingId

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

**Next time** — the agent finds and executes the right tree:

```
dp_find_tree({ taskDescription: "deploy to staging" })
  → [{ treeId: "deploy-staging", score: 11, family: "deployment" }]

dp_get_history_summary({ treeId: "deploy-staging" })
  → { totalSessions: 8, successRate: 1.0, shortestSuccessfulSteps: 3,
      topFailureReasons: [] }

dp_execute_tree({ treeId: "deploy-staging" })
  → follows the proven path, overrides kick in, family siblings pooled
```

**Or let the agent drive step-by-step** (no internal LLM):

```
dp_start_execution({ treeId: "deploy-staging" })
  → { executionId: "exec-...", status: "awaiting_decision",
      availableEdges: [...], recommendation: { edgeId: "e2", confidence: 0.85 } }

dp_step({ executionId: "exec-...", chosenEdgeId: "e2" })
  → { status: "awaiting_decision", ... }  // repeat until terminal
```

Everything runs locally. Trees, history, and recommendations stay on your machine.

## Scripts

```bash
npm run build      # compile to dist/
npm run test       # 183 tests
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
| Recovery Paths | Cascading fallback (primary → backup → manual) |
| Speed vs Accuracy | Fast (70% fail) vs careful (5% fail) |

The flywheel is observable in every scenario. Multi-Step Reasoning:
```
Phase A Run 1:  485ms, 0% confidence (raw LLM)
Phase A Run 8:  461ms, 80% confidence (bias hints)
Phase B Run 2:  0ms,   100% confidence (full override — zero LLM calls)
```

Recovery Paths (cascading fallback):
```
Phase A avg:  1235ms (LLM picks path, sometimes hits dead primary)
Phase B avg:  31ms   (learned to skip primary — 40x faster)
```

Cross-model mode tests knowledge transfer — a smarter teacher (Pro) establishes successful paths that Flash Lite replays at override-level confidence.

## License

ISC
