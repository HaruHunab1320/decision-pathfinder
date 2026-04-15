import type {
  ScenarioResult,
  RunResult,
  AggregateMetrics,
  BenchmarkReport,
  BenchmarkConfig,
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

export function generateReport(
  scenarios: ScenarioResult[],
  config: BenchmarkConfig,
): BenchmarkReport {
  const allPhaseA = scenarios.flatMap((s) => s.phaseA);
  const allPhaseB = scenarios.flatMap((s) => s.phaseB);

  const phaseAMetrics = computeMetrics(allPhaseA);
  const phaseBMetrics = computeMetrics(allPhaseB);

  const successRateDiff = phaseBMetrics.successRate - phaseAMetrics.successRate;
  const stepsDiff = phaseBMetrics.avgSteps - phaseAMetrics.avgSteps;
  const durationDiff = phaseBMetrics.avgDurationMs - phaseAMetrics.avgDurationMs;
  const errorReduction = phaseAMetrics.totalErrors > 0
    ? (1 - phaseBMetrics.totalErrors / phaseAMetrics.totalErrors) * 100
    : 0;

  return {
    timestamp: new Date().toISOString(),
    model: 'gemini-2.0-flash-lite',
    config,
    scenarios,
    summary: {
      phaseA: phaseAMetrics,
      phaseB: phaseBMetrics,
      improvement: {
        successRate: `${successRateDiff >= 0 ? '+' : ''}${(successRateDiff * 100).toFixed(1)}%`,
        avgSteps: `${stepsDiff >= 0 ? '+' : ''}${stepsDiff.toFixed(1)}`,
        avgDuration: `${durationDiff >= 0 ? '+' : ''}${durationDiff.toFixed(0)}ms`,
        errorReduction: `${errorReduction >= 0 ? '-' : '+'}${Math.abs(errorReduction).toFixed(1)}%`,
      },
    },
  };
}

export function generateMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('# Benchmark Report — decision-pathfinder');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Model: ${report.model} | Runs per phase: ${report.config.runsPerPhase}`);
  lines.push(`Override threshold: ${report.config.overrideThreshold} | Bias threshold: ${report.config.biasThreshold}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Phase A (Baseline) | Phase B (Guided) | Change |');
  lines.push('|--------|-------------------|------------------|--------|');
  lines.push(`| Success Rate | ${(summary.phaseA.successRate * 100).toFixed(1)}% | ${(summary.phaseB.successRate * 100).toFixed(1)}% | ${summary.improvement.successRate} |`);
  lines.push(`| Avg Steps | ${summary.phaseA.avgSteps.toFixed(1)} | ${summary.phaseB.avgSteps.toFixed(1)} | ${summary.improvement.avgSteps} |`);
  lines.push(`| Avg Duration | ${summary.phaseA.avgDurationMs.toFixed(0)}ms | ${summary.phaseB.avgDurationMs.toFixed(0)}ms | ${summary.improvement.avgDuration} |`);
  lines.push(`| Errors (fail+err+max) | ${summary.phaseA.totalErrors} | ${summary.phaseB.totalErrors} | ${summary.improvement.errorReduction} |`);
  lines.push('');

  // Per-scenario breakdown
  lines.push('## Per-Scenario Breakdown');
  lines.push('');

  for (const scenario of report.scenarios) {
    const phaseA = computeMetrics(scenario.phaseA);
    const phaseB = computeMetrics(scenario.phaseB);
    const totalOverrides = scenario.phaseB.reduce((s, r) => s + r.overrideCount, 0);
    const totalBias = scenario.phaseB.reduce((s, r) => s + r.biasCount, 0);

    lines.push(`### ${scenario.scenarioName}`);
    lines.push(`> ${scenario.scenarioDescription}`);
    lines.push('');
    lines.push('| | Phase A | Phase B |');
    lines.push('|-|---------|---------|');
    lines.push(`| Success | ${phaseA.successCount}/${phaseA.totalRuns} | ${phaseB.successCount}/${phaseB.totalRuns} |`);
    lines.push(`| Failure | ${phaseA.failureCount} | ${phaseB.failureCount} |`);
    lines.push(`| Error | ${phaseA.errorCount} | ${phaseB.errorCount} |`);
    lines.push(`| Avg Steps | ${phaseA.avgSteps.toFixed(1)} | ${phaseB.avgSteps.toFixed(1)} |`);
    lines.push(`| Avg Duration | ${phaseA.avgDurationMs.toFixed(0)}ms | ${phaseB.avgDurationMs.toFixed(0)}ms |`);
    if (totalOverrides > 0 || totalBias > 0) {
      lines.push(`| Overrides | — | ${totalOverrides} |`);
      lines.push(`| Bias injections | — | ${totalBias} |`);
    }
    lines.push('');

    // Run details
    lines.push('<details><summary>Run details</summary>');
    lines.push('');
    for (const run of [...scenario.phaseA, ...scenario.phaseB]) {
      const r = run.executionResult;
      lines.push(`- Phase ${run.phase} Run ${run.runIndex + 1}: **${r.status}** (${r.stepCount} steps, ${run.durationMs}ms) path: \`${r.pathTaken.join(' -> ')}\``);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');

    // Bottleneck / recommendation info
    if (scenario.optimizationReport.bottlenecks.length > 0) {
      lines.push(`**Bottleneck nodes:** ${scenario.optimizationReport.bottlenecks.map((b) => `\`${b.nodeId}\` (${(b.failureCount / b.visitCount * 100).toFixed(0)}% fail rate)`).join(', ')}`);
      lines.push('');
    }
    if (scenario.optimizationReport.edgeRecommendations.length > 0) {
      for (const { nodeId, recommendation } of scenario.optimizationReport.edgeRecommendations) {
        lines.push(`**Recommendation at \`${nodeId}\`:** edge \`${recommendation.recommendedEdgeId}\` (confidence: ${(recommendation.confidence * 100).toFixed(1)}%) — ${recommendation.reasoning}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
