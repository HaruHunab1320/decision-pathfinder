import { combine, type OracleResult } from '@_89/confidence-kernel';
import type { DecisionContext } from '../adapters/types.js';
import type { IDecisionMaker } from '../execution/TreeExecutor.js';
import type {
  EdgeRecommendation,
  RecommendationEngine,
} from './RecommendationEngine.js';

/** What a graded-gate signal is handed when it is consulted. */
export interface GradedSignalInput {
  /** The branch point the executor is currently at. */
  context: DecisionContext;
  /** The history-derived recommendation that is about to skip the LLM. */
  recommendation: EdgeRecommendation;
}

/**
 * The opt-in SECOND signal of the graded gate.
 *
 * Return a confidence in [0,1] (or a full `OracleResult` with a `detail`
 * string). It is min-combined with the history confidence, so it can only ever
 * pull the gate DOWN — it can never promote a weak history prior into a skip.
 *
 * Keep it cheap: it is consulted at most once per branch point, and only when
 * history alone would already have skipped the LLM.
 */
export type GradedSignal = (
  input: GradedSignalInput,
) => OracleResult | number | Promise<OracleResult | number>;

export interface GuidedDecisionMakerOptions {
  /**
   * History confidence at or above which the LLM call is skipped entirely.
   * Default: 0.6.
   */
  overrideThreshold?: number;
  /**
   * History confidence at or above which the recommendation is passed to the
   * LLM as a prompt hint (but the LLM still decides). Default: 0.2.
   */
  hintThreshold?: number;
  /**
   * OPT-IN graded gate. When omitted (the default) the skip is decided by the
   * history prior alone — byte-for-byte the pre-Wave-2 behavior.
   *
   * When supplied, a skip additionally requires
   * `combine([history, signal], 'min') >= overrideThreshold`. Since `min` picks
   * the weakest check, a confident history prior can no longer unilaterally
   * skip work: some second cheap check (a precondition probe, a lint/typecheck,
   * a staleness check on the environment) has to agree.
   */
  gradedSignal?: GradedSignal;
  /**
   * Called with a one-line explanation whenever the graded gate BLOCKS a skip
   * that history alone would have taken. Useful for logging; optional.
   */
  onGateBlocked?: (detail: string) => void;
}

function toOracleResult(value: OracleResult | number): OracleResult {
  return typeof value === 'number' ? { confidence: value } : value;
}

/**
 * Wrap an `IDecisionMaker` (an LLM adapter) with history-driven guidance:
 *
 *   confidence >= overrideThreshold → skip the LLM, take the historical best edge
 *   confidence >= hintThreshold     → call the LLM, but bias it with the suggestion
 *   otherwise                       → call the LLM untouched
 *
 * This is the single implementation of the tiering that used to live inline in
 * the MCP server, extracted so the graded gate is testable and reusable.
 *
 * DEFAULT BEHAVIOR IS UNCHANGED: with no `gradedSignal`, the first tier fires on
 * the history prior alone, exactly as before.
 */
export function createGuidedDecisionMaker(
  engine: RecommendationEngine,
  inner: IDecisionMaker,
  options: GuidedDecisionMakerOptions = {},
): IDecisionMaker {
  const overrideThreshold = options.overrideThreshold ?? 0.6;
  const hintThreshold = options.hintThreshold ?? 0.2;
  const gradedSignal = options.gradedSignal;

  return {
    async decide(context: DecisionContext) {
      const rec = engine.getEdgeRecommendation(context.currentNodeId);

      // Tier 1 — high confidence: skip the LLM entirely.
      // Note a drifted edge has already been clamped below overrideThreshold by
      // the engine, so it can never reach this branch.
      if (rec && rec.confidence >= overrideThreshold) {
        const valid = context.availableEdges.some(
          (e) => e.id === rec.recommendedEdgeId,
        );
        if (valid) {
          if (!gradedSignal) {
            return {
              chosenEdgeId: rec.recommendedEdgeId,
              reasoning: `Override (confidence: ${(rec.confidence * 100).toFixed(0)}%)`,
            };
          }

          // Graded mode: the prior only skips work if a second check agrees.
          // Any failure in the signal FAILS CLOSED (fall through to the LLM) —
          // graded mode exists for higher-stakes deployments, so a broken
          // check must never be read as consent to skip.
          let second: OracleResult | null = null;
          try {
            second = toOracleResult(
              await gradedSignal({ context, recommendation: rec }),
            );
          } catch (err) {
            second = {
              confidence: 0,
              detail: `graded signal threw: ${(err as Error).message}`,
            };
          }

          const gate = combine(
            [
              {
                confidence: rec.confidence,
                detail: `history ${(rec.confidence * 100).toFixed(0)}%`,
              },
              second,
            ],
            'min',
          );

          if (gate.confidence >= overrideThreshold) {
            return {
              chosenEdgeId: rec.recommendedEdgeId,
              reasoning: `Override (graded min: ${(gate.confidence * 100).toFixed(0)}%, history: ${(rec.confidence * 100).toFixed(0)}%)`,
            };
          }
          options.onGateBlocked?.(
            `graded gate blocked skip at "${context.currentNodeId}": min ${(gate.confidence * 100).toFixed(0)}% < ${(overrideThreshold * 100).toFixed(0)}%${gate.detail ? ` — ${gate.detail}` : ''}`,
          );
          // fall through to the LLM tiers below
        }
      }

      // Tier 2 — medium confidence: let the LLM decide, but bias the prompt.
      if (rec && rec.confidence >= hintThreshold) {
        return inner.decide({
          ...context,
          metadata: {
            ...context.metadata,
            recommendation: {
              suggestedEdgeId: rec.recommendedEdgeId,
              confidence: rec.confidence,
            },
          },
        });
      }

      // Tier 3 — no usable prior.
      return inner.decide(context);
    },
  };
}
