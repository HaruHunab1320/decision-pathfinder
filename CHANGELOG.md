# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-18

### Added

- **Confidence decay** (#3): Session age weighting via `exp(-days × ln2 / halfLife)`.
  Recent sessions dominate recommendations; stale history fades. Configurable
  `decayHalfLifeDays` (default 30). Set to 0 or Infinity to disable.
- **Session rotation & compaction** (#4): `SessionStore.compact()` retains the
  most recent N sessions and writes a compaction summary. `rotate()` archives
  the file. `loadWithAutoCompact()` auto-triggers when threshold is exceeded.
  Sidecar `.compaction.json` tracks cumulative stats across multiple compactions.
- **Export/import with history** (#5): `dp_export_tree` now accepts
  `includeHistory` to bundle tree + sessions + compaction summary. New
  `dp_import_tree` tool restores the tree, metadata, and optionally all session
  history — enables teammate onboarding from a single file.
- **Multi-process safety** (#6): File-lock wrapper (`FileLock` / `withLock`)
  around session appends, compaction writes, and rotation. Uses exclusive-create
  + stale-lock detection. Safe for multiple MCP server processes on one machine.
- **Failure reason extraction** (#7): `PersistedSession.failureReason` captures
  why a session failed (from the terminal node's error message or the last
  record with an error). `dp_get_history_summary` now returns `topFailureReasons`
  (deduplicated, ranked by frequency).
- **Cost tracking** (#8): `TokenUsage` type (`inputTokens`, `outputTokens`) on
  `IDecisionMaker.decide()` return values. `TreeExecutor` accumulates totals and
  exposes `totalTokenUsage` + `llmCallCount` on `ExecutionResult`. Surfaced in
  `dp_execute_tree` responses.
- **Tree evolution** (#9): `TreeEvolution` analyzer proposes structural edits
  based on session patterns — skippable nodes, shortcut edges, bottleneck flags,
  and edge reordering. New `dp_suggest_edits` MCP tool with configurable
  confidence threshold.
- **Agent-driven MCP mode** (#10): `dp_start_execution` + `dp_step` tools let
  the calling agent make every decision step-by-step. No internal LLM is called.
  Recommendations are provided as hints. Sessions are still recorded for future
  learning.
- **MCP sampling support** (#11): `SamplingAdapter` uses `sampling/createMessage`
  to delegate decisions to the host LLM — zero-config, no API keys needed.
  Auto-detected at connection time; highest priority in provider selection.
  Set `DP_NO_SAMPLING=1` to opt out.

## [1.1.0] - 2026-04-18

### Added

- **Task families**: Trees can now belong to a `family` (e.g., `"deployment"`).
  Sibling trees in the same family pool their session history, so a brand-new
  tree inherits recommendations from experienced siblings at shared decision
  points.
- **Tree discovery (`dp_find_tree`)**: New MCP tool that accepts a natural
  language task description and returns the best-matching trees ranked by tag,
  name, and description relevance. Agents no longer need to know exact tree IDs
  upfront.
- **Tree metadata**: `SerializedTree` format version 2 adds optional
  `metadata` block (`family`, `tags`, `description`, `taskName`, `createdAt`).
  Version 1 tree files continue to load without modification.
- **Tree index**: Persistent sidecar file (`_tree_index.json`) in the sessions
  directory enables fast discovery and family queries without loading every tree
  from disk.
- `dp_start_recording` now accepts optional `family`, `tags`, and `description`
  parameters so trees are discoverable from the moment they're created.
- `dp_list_trees` and `dp_load_tree` responses now include `family` and `tags`.
- `dp_get_recommendation`, `dp_execute_tree`, and `dp_get_analytics` responses
  now indicate how many family-sibling sessions were pooled.
- `TreeIndex` class exported from `persistence` module for programmatic use.
- `TreeMetadata` type exported from `core` module.
- `RecommendationEngine.pooledSessions` field for injecting cross-tree sessions.
- Tests for `TreeIndex` (CRUD, family queries, search ranking, rebuild) and
  family-pooled recommendations.

### Fixed

- **Recovery Paths benchmark scenario**: Failure edges now cascade (primary →
  backup → manual fallback) instead of routing directly to the terminal failure
  node. The scenario now correctly tests cascading recovery — went from 0%
  success to 100%, with Phase B learning to skip the broken primary endpoint
  entirely (Phase A avg 480ms → Phase B avg 32ms, 15x speedup via overrides).

### Changed

- `SerializedTree.version` type widened from `1` to `1 | 2`. Serializer emits
  version 2; deserializer accepts both.
- `RecommendationEngine` internally merges tracker-owned sessions with
  `pooledSessions` — existing behavior unchanged when `pooledSessions` is empty.

## [1.0.0] - 2026-04-16

Initial public release.

- Decision tree engine with recording, execution, and recommendation
- MCP server for Claude Code, Cursor, and other MCP clients
- Claude, OpenAI, and Gemini adapter support with auto-detection
- Persistent JSONL session store with recommendation caching
- Benchmark harness with 7 scenario types

[1.2.0]: https://github.com/HaruHunab1320/decision-pathfinder/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/HaruHunab1320/decision-pathfinder/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/HaruHunab1320/decision-pathfinder/releases/tag/v1.0.0
