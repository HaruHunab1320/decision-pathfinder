import type {
  ScenarioResult,
  RunResult,
  AggregateMetrics,
  BenchmarkReport,
  BenchmarkConfig,
  ModelSummary,
} from '../types.js';

function computeMetrics(runs: RunResult[]): AggregateMetrics {
  const total = runs.length;
  if (total === 0) {
    return {
      totalRuns: 0, successCount: 0, failureCount: 0, errorCount: 0,
      maxStepsCount: 0, successRate: 0, avgSteps: 0, avgDurationMs: 0, totalErrors: 0,
    };
  }

  let successCount = 0;
  let failureCount = 0;
  let errorCount = 0;
  let maxStepsCount = 0;
  let totalSteps = 0;
  let totalDuration = 0;

  for (const run of runs) {
    const s = run.executionResult.status;
    if (s === 'success') successCount++;
    else if (s === 'failure') failureCount++;
    else if (s === 'error') errorCount++;
    else if (s === 'max_steps_exceeded') maxStepsCount++;
    totalSteps += run.executionResult.stepCount;
    totalDuration += run.durationMs;
  }

  return {
    totalRuns: total,
    successCount,
    failureCount,
    errorCount,
    maxStepsCount,
    successRate: successCount / total,
    avgSteps: totalSteps / total,
    avgDurationMs: totalDuration / total,
    totalErrors: errorCount + failureCount + maxStepsCount,
  };
}

function computeImprovement(phaseA: AggregateMetrics, phaseB: AggregateMetrics) {
  const successRateDiff = phaseB.successRate - phaseA.successRate;
  const stepsDiff = phaseB.avgSteps - phaseA.avgSteps;
  const durationDiff = phaseB.avgDurationMs - phaseA.avgDurationMs;
  const errorReduction = phaseA.totalErrors > 0
    ? (1 - phaseB.totalErrors / phaseA.totalErrors) * 100
    : 0;

  return {
    successRate: `${successRateDiff >= 0 ? '+' : ''}${(successRateDiff * 100).toFixed(1)}%`,
    avgSteps: `${stepsDiff >= 0 ? '+' : ''}${stepsDiff.toFixed(1)}`,
    avgDuration: `${durationDiff >= 0 ? '+' : ''}${durationDiff.toFixed(0)}ms`,
    errorReduction: `${errorReduction >= 0 ? '-' : '+'}${Math.abs(errorReduction).toFixed(1)}%`,
  };
}

export function generateReport(
  scenarios: ScenarioResult[],
  config: BenchmarkConfig,
): BenchmarkReport {
  // Group by Phase A model
  const byModel = new Map<string, ScenarioResult[]>();
  for (const s of scenarios) {
    const key = s.phaseAModel;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(s);
  }

  const modelSummaries: ModelSummary[] = [];
  for (const [modelName, modelScenarios] of byModel) {
    const allA = modelScenarios.flatMap((s) => s.phaseA);
    const allB = modelScenarios.flatMap((s) => s.phaseB);
    const phaseA = computeMetrics(allA);
    const phaseB = computeMetrics(allB);

    modelSummaries.push({
      phaseAModel: modelName,
      phaseBModel: modelScenarios[0]!.phaseBModel,
      phaseA,
      phaseB,
      improvement: computeImprovement(phaseA, phaseB),
    });
  }

  return {
    timestamp: new Date().toISOString(),
    config,
    scenarios,
    modelSummaries,
  };
}

export function generateMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('# Benchmark Report — decision-pathfinder');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Runs per phase: ${report.config.runsPerPhase} | Override: ${report.config.overrideThreshold} | Bias: ${report.config.biasThreshold}`);
  lines.push('');

  // ── Cross-model comparison table ──
  lines.push('## Cross-Model Comparison');
  lines.push('');
  lines.push('Phase A (teacher) builds history, Phase B (student = flash-lite) follows recommendations.');
  lines.push('');
  lines.push('| Teacher Model | Phase A Success | Phase B Success | Change | Phase A Errors | Phase B Errors | Error Reduction |');
  lines.push('|--------------|----------------|----------------|--------|---------------|---------------|-----------------|');

  for (const ms of report.modelSummaries) {
    lines.push(
      `| ${ms.phaseAModel} | ${(ms.phaseA.successRate * 100).toFixed(1)}% | ${(ms.phaseB.successRate * 100).toFixed(1)}% | ${ms.improvement.successRate} | ${ms.phaseA.totalErrors} | ${ms.phaseB.totalErrors} | ${ms.improvement.errorReduction} |`,
    );
  }
  lines.push('');

  // ── Latency comparison ──
  lines.push('### Latency');
  lines.push('');
  lines.push('| Teacher Model | Phase A Avg Duration | Phase B Avg Duration | Change |');
  lines.push('|--------------|---------------------|---------------------|--------|');
  for (const ms of report.modelSummaries) {
    lines.push(
      `| ${ms.phaseAModel} | ${ms.phaseA.avgDurationMs.toFixed(0)}ms | ${ms.phaseB.avgDurationMs.toFixed(0)}ms | ${ms.improvement.avgDuration} |`,
    );
  }
  lines.push('');

  // ── Per-model, per-scenario breakdown ──
  // Group scenarios by model
  const byModel = new Map<string, ScenarioResult[]>();
  for (const s of report.scenarios) {
    const key = s.phaseAModel;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(s);
  }

  for (const [modelName, modelScenarios] of byModel) {
    lines.push(`## Teacher: ${modelName}`);
    lines.push('');

    for (const scenario of modelScenarios) {
      const phaseA = computeMetrics(scenario.phaseA);
      const phaseB = computeMetrics(scenario.phaseB);
      const totalOverrides = scenario.phaseB.reduce(
        (s, r) => s + r.overrideCount,
        0,
      );
      const totalBias = scenario.phaseB.reduce((s, r) => s + r.biasCount, 0);

      lines.push(`### ${scenario.scenarioName}`);
      lines.push(`> ${scenario.scenarioDescription}`);
      lines.push('');
      lines.push('| | Phase A | Phase B |');
      lines.push('|-|---------|---------|');
      lines.push(
        `| Success | ${phaseA.successCount}/${phaseA.totalRuns} | ${phaseB.successCount}/${phaseB.totalRuns} |`,
      );
      lines.push(`| Failure | ${phaseA.failureCount} | ${phaseB.failureCount} |`);
      lines.push(`| Error | ${phaseA.errorCount} | ${phaseB.errorCount} |`);
      lines.push(
        `| Avg Steps | ${phaseA.avgSteps.toFixed(1)} | ${phaseB.avgSteps.toFixed(1)} |`,
      );
      lines.push(
        `| Avg Duration | ${phaseA.avgDurationMs.toFixed(0)}ms | ${phaseB.avgDurationMs.toFixed(0)}ms |`,
      );
      if (totalOverrides > 0 || totalBias > 0) {
        lines.push(`| Overrides | — | ${totalOverrides} |`);
        lines.push(`| Bias injections | — | ${totalBias} |`);
      }
      lines.push('');

      // Learning progression table
      const allRuns = [...scenario.phaseA, ...scenario.phaseB];
      lines.push('**Learning Progression:**');
      lines.push('');
      lines.push('| Run | Phase | Result | Steps | Duration | Cum. Success | Confidence | Overrides | Bias |');
      lines.push('|-----|-------|--------|-------|----------|-------------|------------|-----------|------|');
      for (const run of allRuns) {
        const r = run.executionResult;
        lines.push(
          `| ${run.phase}${run.runIndex + 1} | ${run.phase} | ${r.status} | ${r.stepCount} | ${run.durationMs}ms | ${(run.cumulativeSuccessRate * 100).toFixed(0)}% | ${(run.maxConfidence * 100).toFixed(0)}% | ${run.overrideCount} | ${run.biasCount} |`,
        );
      }
      lines.push('');

      // Run path details
      lines.push('<details><summary>Path details</summary>');
      lines.push('');
      for (const run of allRuns) {
        const r = run.executionResult;
        lines.push(
          `- ${run.phase}${run.runIndex + 1}: \`${r.pathTaken.join(' -> ')}\``,
        );
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');

      if (scenario.optimizationReport.bottlenecks.length > 0) {
        lines.push(
          `**Bottleneck nodes:** ${scenario.optimizationReport.bottlenecks.map((b) => `\`${b.nodeId}\` (${((b.failureCount / b.visitCount) * 100).toFixed(0)}% fail)`).join(', ')}`,
        );
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
