import { PathTracker } from '../../src/tracking/PathTracker.js';
import { RecommendationEngine } from '../../src/recommendation/RecommendationEngine.js';
import { TreeExecutor } from '../../src/execution/TreeExecutor.js';
import { GeminiAdapter } from '../../src/adapters/GeminiAdapter.js';
import { GuidedDecisionMaker } from './adapters/guided-decision-maker.js';
import type {
  ScenarioDefinition,
  ScenarioResult,
  RunResult,
  OptimizationReport,
  BenchmarkConfig,
  ModelConfig,
} from './types.js';
import type { IDecisionMaker, ExecutionResult } from '../../src/execution/TreeExecutor.js';

const STATUS_ICONS: Record<string, string> = {
  success: 'ok',
  failure: 'FAIL',
  error: 'ERR',
  max_steps_exceeded: 'MAX',
};

export async function runScenarioWithModel(
  scenario: ScenarioDefinition,
  scenarioIndex: number,
  totalScenarios: number,
  phaseAModel: ModelConfig,
  phaseBModel: ModelConfig,
  apiKey: string,
  config: BenchmarkConfig,
): Promise<ScenarioResult> {
  console.log(
    `\n  [${scenarioIndex + 1}/${totalScenarios}] ${scenario.name}`,
  );

  const tracker = new PathTracker();

  const phaseAAdapter = new GeminiAdapter({
    apiKey,
    modelName: phaseAModel.modelId,
    maxRetries: 4,
    retryDelayMs: 2000,
  });

  // ── Phase A: Teacher model builds history ──
  console.log(`    Phase A (${phaseAModel.name}):`);
  const phaseARuns: RunResult[] = [];
  const phaseAStartSession = tracker.getAllSessions().length;

  for (let i = 0; i < config.runsPerPhase; i++) {
    const result = await executeRun(
      scenario,
      tracker,
      phaseAAdapter,
      i,
      config.runsPerPhase,
      'A',
    );
    phaseARuns.push(result);

    if (i < config.runsPerPhase - 1) {
      await delay(config.interRunDelayMs);
    }
  }

  // ── Build recommendation engine from Phase A data ──
  const engine = new RecommendationEngine(scenario.tree, tracker);
  const report = engine.generateOptimizationReport();
  const bottlenecks = engine.identifyBottlenecks(0.3);

  const edgeRecsArray: OptimizationReport['edgeRecommendations'] = [];
  for (const [nodeId, rec] of report.edgeRecommendations) {
    edgeRecsArray.push({ nodeId, recommendation: rec });
  }

  const optimizationReport: OptimizationReport = {
    analysis: report.analysis,
    bottlenecks: report.bottlenecks,
    edgeRecommendations: edgeRecsArray,
  };

  const phaseASuccesses = phaseARuns.filter(
    (r) => r.executionResult.status === 'success',
  ).length;
  console.log(
    `    Analysis: ${tracker.getAllSessions().length - phaseAStartSession} sessions, ${phaseASuccesses}/${config.runsPerPhase} success, ${bottlenecks.length} bottleneck(s)`,
  );

  // ── Phase B: Student model uses teacher's recommendations ──
  const phaseBAdapter = new GeminiAdapter({
    apiKey,
    modelName: phaseBModel.modelId,
    maxRetries: 4,
    retryDelayMs: 2000,
  });

  console.log(`    Phase B (${phaseBModel.name} + guided):`);
  const guidedMaker = new GuidedDecisionMaker(
    phaseBAdapter,
    engine,
    config.overrideThreshold,
    config.biasThreshold,
  );

  const phaseBRuns: RunResult[] = [];

  for (let i = 0; i < config.runsPerPhase; i++) {
    guidedMaker.resetCounters();
    const result = await executeRun(
      scenario,
      tracker,
      guidedMaker,
      i,
      config.runsPerPhase,
      'B',
      guidedMaker,
    );
    phaseBRuns.push(result);

    if (i < config.runsPerPhase - 1) {
      await delay(config.interRunDelayMs);
    }
  }

  return {
    scenarioName: scenario.name,
    scenarioDescription: scenario.description,
    phaseAModel: phaseAModel.name,
    phaseBModel: phaseBModel.name,
    phaseA: phaseARuns,
    phaseB: phaseBRuns,
    optimizationReport,
  };
}

async function executeRun(
  scenario: ScenarioDefinition,
  tracker: PathTracker,
  decisionMaker: IDecisionMaker,
  runIndex: number,
  totalRuns: number,
  phase: 'A' | 'B',
  guidedMaker?: GuidedDecisionMaker,
): Promise<RunResult> {
  const start = Date.now();

  const executor = new TreeExecutor(
    scenario.tree,
    decisionMaker,
    tracker,
    {
      maxSteps: 20,
      toolHandlers: scenario.toolHandlers,
      conditionEvaluators: scenario.conditionEvaluators,
    },
  );

  let executionResult: ExecutionResult;
  try {
    executionResult = await executor.execute(scenario.startNodeId);
  } catch (err) {
    executionResult = {
      finalNodeId: scenario.startNodeId,
      finalNode: scenario.tree.getNode(scenario.startNodeId)!,
      status: 'error',
      pathTaken: [],
      variables: {},
      stepCount: 0,
      error: (err as Error).message,
    };
  }

  const durationMs = Date.now() - start;
  const sessions = tracker.getAllSessions();
  const sessionRecords = sessions[sessions.length - 1] ?? [];

  const overrideCount = guidedMaker?.overrideCount ?? 0;
  const biasCount = guidedMaker?.biasCount ?? 0;

  const statusIcon = STATUS_ICONS[executionResult.status] ?? '?';
  const guidedInfo =
    phase === 'B' && (overrideCount > 0 || biasCount > 0)
      ? ` [${overrideCount} override, ${biasCount} bias]`
      : '';
  console.log(
    `      Run ${runIndex + 1}/${totalRuns} -> ${statusIcon} (${executionResult.status}, ${executionResult.stepCount} steps, ${durationMs}ms)${guidedInfo}`,
  );

  return {
    runIndex,
    phase,
    executionResult,
    sessionRecords: [...sessionRecords],
    durationMs,
    overrideCount,
    biasCount,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
