/**
 * Cross-model benchmark harness for decision-pathfinder
 *
 * Tests the hypothesis: a smarter model (Pro/Flash) in Phase A builds better
 * recommendations, making Flash Lite in Phase B significantly more successful
 * than Flash Lite guided by its own history.
 *
 * For each Phase A model:
 *   Phase A: Teacher model builds history across N runs
 *   Phase B: Flash Lite (student) follows teacher's recommendations
 *
 * Usage:
 *   GEMINI_API_KEY=your-key npm run benchmark
 *   GEMINI_API_KEY=your-key npm run benchmark -- --runs 5
 *   GEMINI_API_KEY=your-key npm run benchmark -- --models flash-lite  (single model only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllScenarios } from './benchmark/scenarios/index.js';
import { runScenarioWithModel } from './benchmark/runner.js';
import {
  generateReport,
  generateMarkdown,
} from './benchmark/reporting/report-generator.js';
import type {
  BenchmarkConfig,
  ScenarioResult,
  ModelConfig,
} from './benchmark/types.js';

const ROOT = path.resolve(import.meta.dirname!, '..');

const ALL_MODELS: ModelConfig[] = [
  { name: 'flash-lite', modelId: 'gemini-2.0-flash-lite' },
  { name: 'flash', modelId: 'gemini-2.0-flash' },
  { name: 'pro', modelId: 'gemini-2.5-pro-preview-05-06' },
];

const STUDENT_MODEL: ModelConfig = {
  name: 'flash-lite',
  modelId: 'gemini-2.0-flash-lite',
};

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

  const modelsIndex = args.indexOf('--models');
  const modelFilter = modelsIndex >= 0 ? args[modelsIndex + 1] : undefined;

  const phaseAModels = modelFilter
    ? ALL_MODELS.filter((m) => m.name === modelFilter)
    : ALL_MODELS;

  if (phaseAModels.length === 0) {
    console.error(
      `Unknown model "${modelFilter}". Available: ${ALL_MODELS.map((m) => m.name).join(', ')}`,
    );
    process.exit(1);
  }

  const config: BenchmarkConfig = {
    runsPerPhase,
    interRunDelayMs: 500,
    interScenarioDelayMs: 2000,
    overrideThreshold: 0.6,
    biasThreshold: 0.2,
    phaseAModels,
    phaseBModel: STUDENT_MODEL,
  };

  console.log('=== decision-pathfinder Cross-Model Benchmark ===');
  console.log(`Student (Phase B): ${STUDENT_MODEL.name}`);
  console.log(
    `Teachers (Phase A): ${phaseAModels.map((m) => m.name).join(', ')}`,
  );
  console.log(`Runs per phase: ${config.runsPerPhase}`);

  const scenarios = getAllScenarios();
  const totalExecutions =
    phaseAModels.length * scenarios.length * 2 * config.runsPerPhase;
  console.log(
    `Scenarios: ${scenarios.length} | Models: ${phaseAModels.length} | Total executions: ${totalExecutions}`,
  );

  const allResults: ScenarioResult[] = [];
  const startTime = Date.now();

  for (let m = 0; m < phaseAModels.length; m++) {
    const model = phaseAModels[m]!;
    console.log(
      `\n${'='.repeat(60)}\nTeacher model: ${model.name} (${model.modelId})\n${'='.repeat(60)}`,
    );

    for (let i = 0; i < scenarios.length; i++) {
      const result = await runScenarioWithModel(
        scenarios[i]!,
        i,
        scenarios.length,
        model,
        STUDENT_MODEL,
        apiKey,
        config,
      );
      allResults.push(result);

      if (i < scenarios.length - 1) {
        await new Promise((r) => setTimeout(r, config.interScenarioDelayMs));
      }
    }

    if (m < phaseAModels.length - 1) {
      console.log('\n  (cooling down 5s between models...)');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const totalTime = Date.now() - startTime;

  // Generate reports
  console.log('\n=== Generating Reports ===');

  const report = generateReport(allResults, config);
  const markdown = generateMarkdown(report);

  const jsonPath = path.resolve(ROOT, 'benchmark-results.json');
  const mdPath = path.resolve(ROOT, 'benchmark-report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  wrote ${jsonPath}`);

  fs.writeFileSync(mdPath, markdown, 'utf-8');
  console.log(`  wrote ${mdPath}`);

  // Print summary
  console.log(`\n=== Summary (${(totalTime / 1000).toFixed(1)}s total) ===\n`);
  console.log(
    '| Teacher Model | Phase A Success | Phase B (flash-lite) Success | Change | Error Reduction |',
  );
  console.log(
    '|--------------|----------------|------------------------------|--------|-----------------|',
  );
  for (const ms of report.modelSummaries) {
    console.log(
      `| ${ms.phaseAModel.padEnd(13)} | ${(ms.phaseA.successRate * 100).toFixed(1).padStart(14)}% | ${(ms.phaseB.successRate * 100).toFixed(1).padStart(28)}% | ${ms.improvement.successRate.padStart(6)} | ${ms.improvement.errorReduction.padStart(15)} |`,
    );
  }
  console.log('');

  // Find best teacher
  const best = report.modelSummaries.reduce((a, b) =>
    b.phaseB.successRate > a.phaseB.successRate ? b : a,
  );
  console.log(
    `Best teacher for flash-lite: ${best.phaseAModel} (${(best.phaseB.successRate * 100).toFixed(1)}% Phase B success)`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
