import type { DecisionContext } from '../../../src/adapters/ILLMDecisionTreeAdapter.js';
import type { IDecisionMaker } from '../../../src/execution/TreeExecutor.js';
import type { RecommendationEngine } from '../../../src/recommendation/RecommendationEngine.js';

export class GuidedDecisionMaker implements IDecisionMaker {
  private inner: IDecisionMaker;
  private engine: RecommendationEngine;
  private overrideThreshold: number;
  private biasThreshold: number;

  // Counters for the current run (reset between runs)
  public overrideCount = 0;
  public biasCount = 0;

  constructor(
    inner: IDecisionMaker,
    engine: RecommendationEngine,
    overrideThreshold = 0.8,
    biasThreshold = 0.3,
  ) {
    this.inner = inner;
    this.engine = engine;
    this.overrideThreshold = overrideThreshold;
    this.biasThreshold = biasThreshold;
  }

  resetCounters(): void {
    this.overrideCount = 0;
    this.biasCount = 0;
  }

  async decide(
    context: DecisionContext,
  ): Promise<{ chosenEdgeId: string; reasoning?: string }> {
    const rec = this.engine.getEdgeRecommendation(context.currentNodeId);

    // High confidence: hard override
    if (rec && rec.confidence >= this.overrideThreshold) {
      const valid = context.availableEdges.some(
        (e) => e.id === rec.recommendedEdgeId,
      );
      if (valid) {
        this.overrideCount++;
        return {
          chosenEdgeId: rec.recommendedEdgeId,
          reasoning: `Override: confidence ${(rec.confidence * 100).toFixed(1)}% — ${rec.reasoning}`,
        };
      }
    }

    // Medium confidence: bias the prompt via metadata
    if (rec && rec.confidence >= this.biasThreshold) {
      this.biasCount++;
      const biasedContext: DecisionContext = {
        ...context,
        metadata: {
          ...context.metadata,
          recommendation: {
            suggestedEdgeId: rec.recommendedEdgeId,
            confidence: rec.confidence,
            reasoning: rec.reasoning,
          },
        },
      };
      return this.inner.decide(biasedContext);
    }

    // Low confidence: pass-through
    return this.inner.decide(context);
  }
}
