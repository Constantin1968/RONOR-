/**
 * Knowledge Context Provider — Stage F
 * MIP-015 STEP 3 · Requirement 3F
 *
 * The seam through which R-Knowledge supplies grounded context to the inference
 * pipeline. This is the ONLY route by which retrieved knowledge reaches another
 * plane.
 *
 * ── Why this is not simply a call from R-Context to R-Knowledge ──────────────
 *
 * Three properties have to hold simultaneously, and a direct call satisfies none of
 * them reliably.
 *
 * 1. THE PIPELINE MUST NOT DEPEND ON THE PLANE. R-Knowledge is optional and is
 *    absent entirely when disabled. R-Context therefore depends on this narrow
 *    provider interface, and a provider is either present or it is not. The
 *    orchestrator's eight-plane composition is unchanged, and the inference path
 *    behaves identically when no provider is supplied — which is what keeps the
 *    disabled-mode equivalence gate (G5) intact after Stage F exists.
 *
 * 2. A KNOWLEDGE FAILURE MUST NOT BECOME AN INFERENCE FAILURE. Retrieval is an
 *    enrichment. If the store is unreachable, the correct behaviour is to answer
 *    without grounding and say so — not to fail a request the model could have
 *    served. Every path through `provide()` therefore returns a value; none throws.
 *
 * 3. INJECTED CONTENT MUST REMAIN MARKED AS DATA. What crosses this boundary is a
 *    nonce-delimited data region produced by the RAG composer, not free text spliced
 *    into a prompt. The delimiter is unpredictable per request, so retrieved content
 *    cannot close it and issue instructions. This is the architectural control on
 *    injection and it survives the crossing because the region crosses intact.
 */

import type { RKnowledgePlane } from '../planes/r-knowledge';
import type { KnowledgeClassification } from '../planes/r-knowledge/types';

/** What the inference pipeline asks for. */
export interface ContextRequest {
  query: string;
  /**
   * Classification ceiling for this request.
   *
   * Supplied by the CALLER, because the caller knows who is asking. A provider that
   * chose its own ceiling would be deciding an authorisation question with no
   * knowledge of the requester.
   */
  maxClassification?: KnowledgeClassification;
  k?: number;
}

/** What the inference pipeline receives. */
export interface ContextContribution {
  /** True only when grounded context is present and usable. */
  grounded: boolean;
  /**
   * The nonce-delimited data region, ready to be placed in a system prompt. Null
   * when no grounding is available, for any reason.
   */
  dataRegion: string | null;
  /** Citation labels the model may use, each already bound to a stored object. */
  citations: string[];
  /** Number of distinct sources represented. */
  sourceCount: number;
  /**
   * Why grounding is absent or partial. Non-null whenever `grounded` is false, and
   * also non-null when grounding succeeded in a degraded mode.
   */
  reason: string | null;
  detail: string | null;
  /** Plane degradation level at the time of the request, 0 when no plane exists. */
  degradationLevel: number;
  /**
   * True when the contribution is complete: every citation resolved and the
   * sufficiency threshold met. A partial contribution is still usable, but the
   * caller is told.
   */
  complete: boolean;
}

export interface KnowledgeContextProvider {
  provide(request: ContextRequest): Promise<ContextContribution>;
}

/**
 * The absence of a provider.
 *
 * Returned when the plane is disabled or absent. Null-object rather than `null`, so
 * that R-Context has no conditional at the call site and cannot forget one. Every
 * field states the absence explicitly rather than leaving a caller to infer it from
 * an empty string.
 */
export const ABSENT_CONTEXT_PROVIDER: KnowledgeContextProvider = {
  async provide(): Promise<ContextContribution> {
    return {
      grounded: false,
      dataRegion: null,
      citations: [],
      sourceCount: 0,
      reason: 'KNOWLEDGE_ABSENT',
      detail: 'No knowledge plane is present. The request proceeds without grounding.',
      degradationLevel: 0,
      complete: false,
    };
  },
};

/**
 * A provider backed by a live R-Knowledge plane.
 */
export function createKnowledgeContextProvider(
  plane: RKnowledgePlane
): KnowledgeContextProvider {
  return {
    async provide(request: ContextRequest): Promise<ContextContribution> {
      // An empty or whitespace query cannot be embedded and would produce a
      // meaningless nearest-neighbour result. Refusing here avoids a pointless
      // round trip and a vector that represents nothing.
      const query = typeof request.query === 'string' ? request.query.trim() : '';
      if (query.length === 0) {
        return {
          grounded: false,
          dataRegion: null,
          citations: [],
          sourceCount: 0,
          reason: 'RETRIEVAL_EMPTY',
          detail: 'the query is empty, so no retrieval was attempted',
          degradationLevel: 0,
          complete: false,
        };
      }

      try {
        const composition = await plane.compose({
          query,
          k: request.k,
          maxClassification: request.maxClassification,
        });

        if (!composition.ok || composition.composedPrompt === null) {
          // A refusal is reported, never converted into an exception. The inference
          // request proceeds ungrounded.
          return {
            grounded: false,
            dataRegion: null,
            citations: [],
            sourceCount: 0,
            reason: composition.reason ?? 'RETRIEVAL_UNAVAILABLE',
            detail:
              'grounding was not available for this request; the request proceeds ungrounded',
            degradationLevel: composition.degradationLevel,
            complete: false,
          };
        }

        return {
          grounded: true,
          dataRegion: composition.composedPrompt,
          citations: composition.citations,
          sourceCount: composition.sourcesUsed,
          // A degraded-but-successful contribution still carries a reason, because
          // "grounded" and "grounded from a fully healthy corpus" are different
          // claims and the caller may care about the difference.
          reason: composition.degradationLevel > 0 ? 'KNOWLEDGE_DEGRADED' : null,
          detail:
            composition.strippedCitations.length > 0
              ? `${composition.strippedCitations.length} citation(s) could not be resolved and were stripped`
              : null,
          degradationLevel: composition.degradationLevel,
          complete: composition.complete,
        };
      } catch (error) {
        // The load-bearing catch. Nothing inside R-Knowledge is permitted to break
        // the inference pipeline: a defect in retrieval must degrade the answer, not
        // deny it. This is the boundary where that guarantee is enforced.
        return {
          grounded: false,
          dataRegion: null,
          citations: [],
          sourceCount: 0,
          reason: 'RETRIEVAL_UNAVAILABLE',
          detail:
            'the knowledge plane raised an unexpected error; the request proceeds ungrounded: ' +
            (error instanceof Error ? error.message.slice(0, 200) : 'unknown'),
          degradationLevel: 3,
          complete: false,
        };
      }
    },
  };
}
