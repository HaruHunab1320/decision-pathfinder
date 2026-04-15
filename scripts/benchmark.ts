/**
 * Benchmark harness for decision-pathfinder
 *
 * Runs 7 scenarios designed to challenge Gemini Flash Lite, each executed in
 * two phases:
 *   Phase A (Baseline): Raw GeminiAdapter, no recommendations
 *   Phase B (Guided):   GuidedDecisionMaker using RecommendationEngine data
 *
 * Produces:
 *   benchmark-results.json  — raw data
 *   benchmark-report.md     — human-readable comparison
 *
 * Usage:
 *   GEMINI_API_KEY=your-key npm run benchmark
 *   GEMINI_API_KEY=your-key npm run benchmark -- --runs 5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllScenarios } from './benchmark/scenarios/index.js';
import { runScenario } from './benchmark/runner.js';
import { generateReport, generateMarkdown } from './benchmark/reporting/report-generator.js';
import type { BenchmarkConfig, ScenarioResult } from './benchmark/types.js';

const ROOT = path.resolve(import.meta.dirname!, '..');

async function main() {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    console.error(
      'Error: GEMINI_API_KEY environment variable is required.\n' +
      'Usage: GEMINI_API_KEY=your-key npm run benchmark',
    );
    process.exit(1);
  }

  // Parse CLI args
  const args = process.argv.slice(2);
  const runsIndex = args.indexOf('--runs');
  const runsPerPhase = runsIndex >= 0 ? parseInt(args[runsIndex + 1]!, 10) : 5;

  const config: BenchmarkConfig = {
    runsPerPhase,
    interRunDelayMs: 500,
    interScenarioDelayMs: 2000,
    overrideThreshold: 0.6,
    biasThreshold: 0.2,
  };

  console.log('=== decision-pathfinder Benchmark ===');
  console.log(`Model: gemini-2.0-flash-lite`);
  console.log(`Runs per phase: ${config.runsPerPhase}`);
  console.log(`Override threshold: ${config.overrideThreshold}, Bias threshold: ${config.biasThreshold}`);

  const scenarios = getAllScenarios();
  console.log(`Scenarios: ${scenarios.length}`);
  console.log(`Total executions: ${scenarios.length * 2 * config.runsPerPhase}`);

  const results: ScenarioResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < scenarios.length; i++) {
    const result = await runScenario(
      scenarios[i]!,
      i,
      scenarios.length,
      apiKey,
      config,
    );
    results.push(result);

    if (i < scenarios.length - 1) {
      console.log(`  (cooling down ${config.interScenarioDelayMs}ms...)`);
      await new Promise((r) => setTimeout(r, config.interScenarioDelayMs));
    }
  }

  const totalTime = Date.now() - startTime;

  // Generate reports
  console.log('\n=== Generating Reports ===');

  const report = generateReport(results, config);
  const markdown = generateMarkdown(report);

  const jsonPath = path.resolve(ROOT, 'benchmark-results.json');
  const mdPath = path.resolve(ROOT, 'benchmark-report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  wrote ${jsonPath}`);

  fs.writeFileSync(mdPath, markdown, 'utf-8');
  console.log(`  wrote ${mdPath}`);

  // Print summary
  const { summary } = report;
  console.log('\n=== Summary ===');
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log('');
  console.log('| Metric              | Phase A | Phase B | Change |');
  console.log('|---------------------|---------|---------|--------|');
  console.log(`| Success Rate        | ${(summary.phaseA.successRate * 100).toFixed(1)}%   | ${(summary.phaseB.successRate * 100).toFixed(1)}%   | ${summary.improvement.successRate} |`);
  console.log(`| Avg Steps           | ${summary.phaseA.avgSteps.toFixed(1)}    | ${summary.phaseB.avgSteps.toFixed(1)}    | ${summary.improvement.avgSteps} |`);
  console.log(`| Errors              | ${summary.phaseA.totalErrors}       | ${summary.phaseB.totalErrors}       | ${summary.improvement.errorReduction} |`);
  console.log('');

  if (summary.phaseB.successRate > summary.phaseA.successRate) {
    console.log('Phase B (guided) outperformed Phase A (baseline).');
  } else if (summary.phaseB.successRate === summary.phaseA.successRate) {
    console.log('No difference between phases (may need more runs for statistical significance).');
  } else {
    console.log('Phase A outperformed Phase B (unexpected — check scenario design).');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
