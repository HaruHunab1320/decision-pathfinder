import type { DecisionTree } from '../../src/core/DecisionTree.js';
import type { ExecutionResult, ToolHandler, ConditionEvaluator } from '../../src/execution/TreeExecutor.js';
import type { EnhancedPathRecord } from '../../src/core/interfaces.js';
import type { PathAnalysis, NodeStats, EdgeRecommendation } from '../../src/recommendation/RecommendationEngine.js';

export interface ScenarioDefinition {
  name: string;
  description: string;
  tree: DecisionTree;
  toolHandlers: Map<string, ToolHandler>;
  conditionEvaluators: Map<string, ConditionEvaluator>;
  startNodeId: string;
}

export interface RunResult {
  runIndex: number;
  phase: 'A' | 'B';
  executionResult: ExecutionResult;
  sessionRecords: EnhancedPathRecord[];
  durationMs: number;
  overrideCount: number;
  biasCount: number;
}

export interface OptimizationReport {
  analysis: PathAnalysis;
  bottlenecks: NodeStats[];
  edgeRecommendations: Array<{ nodeId: string; recommendation: EdgeRecommendation }>;
}

export interface ScenarioResult {
  scenarioName: string;
  scenarioDescription: string;
  phaseA: RunResult[];
  phaseB: RunResult[];
  optimizationReport: OptimizationReport;
}

export interface AggregateMetrics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  errorCount: number;
  maxStepsCount: number;
  successRate: number;
  avgSteps: number;
  avgDurationMs: number;
  totalErrors: number;
}

export interface BenchmarkConfig {
  runsPerPhase: number;
  interRunDelayMs: number;
  interScenarioDelayMs: number;
  overrideThreshold: number;
  biasThreshold: number;
}

export interface BenchmarkReport {
  timestamp: string;
  model: string;
  config: BenchmarkConfig;
  scenarios: ScenarioResult[];
  summary: {
    phaseA: AggregateMetrics;
    phaseB: AggregateMetrics;
    improvement: {
      successRate: string;
      avgSteps: string;
      avgDuration: string;
      errorReduction: string;
    };
  };
}
