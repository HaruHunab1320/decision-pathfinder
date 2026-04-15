import { PathTracker } from '../../src/tracking/PathTracker.js';
import { RecommendationEngine } from '../../src/recommendation/RecommendationEngine.js';
import { TreeExecutor } from '../../src/execution/TreeExecutor.js';
import { GeminiAdapter } from '../../src/adapters/GeminiAdapter.js';
import { GuidedDecisionMaker } from './adapters/guided-decision-maker.js';
import type { ScenarioDefinition, ScenarioResult, RunResult, OptimizationReport, BenchmarkConfig } from './types.js';
import type { IDecisionMaker, ExecutionResult } from '../../src/execution/TreeExecutor.js';

const STATUS_ICONS: Record<string, string> = {
  success: 'ok',
  failure: 'FAIL',
  error: 'ERR',
  max_steps_exceeded: 'MAX',
};

export async function runScenario(
  scenario: ScenarioDefinition,
  scenarioIndex: number,
  totalScenarios: number,
  apiKey: string,
  config: BenchmarkConfig,
): Promise<ScenarioResult> {
  console.log(`\n[${scenarioIndex + 1}/${totalScenarios}] ${scenario.name}`);
  console.log(`  ${scenario.description}`);

  const tracker = new PathTracker();

  const geminiAdapter = new GeminiAdapter({
    apiKey,
    modelName: 'gemini-2.0-flash-lite',
    maxRetries: 4,
    retryDelayMs: 2000,
    maxOutputTokens: 100,
  });

  // ── Phase A: Baseline ──
  console.log('  Phase A (baseline):');
  const phaseARuns: RunResult[] = [];
  const phaseAStartSession = tracker.getAllSessions().length;

  for (let i = 0; i < config.runsPerPhase; i++) {
    const result = await executeRun(
      scenario,
      tracker,
      geminiAdapter,
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

  // Convert edgeRecommendations Map to serializable array
  const edgeRecsArray: OptimizationReport['edgeRecommendations'] = [];
  for (const [nodeId, rec] of report.edgeRecommendations) {
    edgeRecsArray.push({ nodeId, recommendation: rec });
  }

  const optimizationReport: OptimizationReport = {
    analysis: report.analysis,
    bottlenecks: report.bottlenecks,
    edgeRecommendations: edgeRecsArray,
  };

  console.log(`  Analysis: ${tracker.getAllSessions().length - phaseAStartSession} sessions, ${bottlenecks.length} bottleneck(s)`);

  // ── Phase B: Guided ──
  console.log('  Phase B (guided):');
  const guidedMaker = new GuidedDecisionMaker(
    geminiAdapter,
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
    // Shouldn't happen since executor catches errors, but just in case
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
  const guidedInfo = phase === 'B' && (overrideCount > 0 || biasCount > 0)
    ? ` [${overrideCount} override, ${biasCount} bias]`
    : '';
  console.log(
    `    Run ${runIndex + 1}/${totalRuns} -> ${statusIcon} (${executionResult.status}, ${executionResult.stepCount} steps, ${durationMs}ms)${guidedInfo}`,
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
