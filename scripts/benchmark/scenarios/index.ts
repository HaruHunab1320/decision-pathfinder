import type { ScenarioDefinition } from '../types.js';
import { buildAmbiguousRouting } from './ambiguous-routing.js';
import { buildToolChainFailures } from './tool-chain-failures.js';
import { buildMultiStepReasoning } from './multi-step-reasoning.js';
import { buildAdversarialPrompts } from './adversarial-prompts.js';
import { buildHighBranching } from './high-branching.js';
import { buildRecoveryPaths } from './recovery-paths.js';
import { buildSpeedVsAccuracy } from './speed-vs-accuracy.js';

export function getAllScenarios(): ScenarioDefinition[] {
  return [
    buildAmbiguousRouting(),
    buildToolChainFailures(),
    buildMultiStepReasoning(),
    buildAdversarialPrompts(),
    buildHighBranching(),
    buildRecoveryPaths(),
    buildSpeedVsAccuracy(),
  ];
}
