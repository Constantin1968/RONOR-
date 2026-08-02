/**
 * R-Context Plane
 * Plane 2 of 7 — Context management, compression, and enrichment.
 *
 * Responsibilities:
 * - Conversation history management
 * - Token counting and budget enforcement
 * - Semantic compression when context exceeds threshold
 * - Context enrichment with retrieved knowledge
 * - Session state persistence
 */

import { createLogger } from '../../utils/logger';
import type { RONORRequest, PlaneHealth, ContextMessage } from '../../types';
import type { KnowledgeContextProvider } from '../../knowledge/context-provider';

const logger = createLogger('Plane:R-Context');

const MAX_TOKENS = parseInt(process.env.CONTEXT_MAX_TOKENS || '128000', 10);
const COMPRESSION_THRESHOLD = parseFloat(process.env.CONTEXT_COMPRESSION_THRESHOLD || '0.8');

// In-memory session store (replace with Redis in production)
const sessionStore = new Map<string, ContextMessage[]>();

export class RContextPlane {
  private requestsTotal = 0;
  private errorsTotal = 0;

  /**
   * Optional knowledge grounding (MIP-015 STEP 3, Stage F).
   *
   * `null` when R-Knowledge is absent, which is its state in every deployment that
   * has not enabled the plane. The field is optional rather than a required
   * constructor argument so that the plane's construction signature is unchanged and
   * every existing caller — including the composition root and the existing tests —
   * continues to work untouched.
   */
  private knowledgeProvider: KnowledgeContextProvider | null = null;

  /** Grounding statistics, for diagnosis. */
  private groundedRequests = 0;
  private ungroundedRequests = 0;

  async init(): Promise<void> {
    logger.info('R-Context plane initialised ✓');
  }

  /**
   * Attach knowledge grounding.
   *
   * Separate from `init()` deliberately. R-Knowledge is constructed by the
   * composition root only when enabled, and attaching afterwards means R-Context has
   * no knowledge of how the plane is created, no import of it, and no behaviour that
   * changes when it is absent.
   */
  attachKnowledgeProvider(provider: KnowledgeContextProvider | null): void {
    this.knowledgeProvider = provider;
    if (provider !== null) {
      logger.info('R-Context: knowledge grounding attached (R-Knowledge Stage F)');
    }
  }

  getGroundingStats(): { grounded: number; ungrounded: number; attached: boolean } {
    return {
      grounded: this.groundedRequests,
      ungrounded: this.ungroundedRequests,
      attached: this.knowledgeProvider !== null,
    };
  }

  async process(request: RONORRequest): Promise<RONORRequest> {
    this.requestsTotal++;

    const sessionHistory = sessionStore.get(request.sessionId) || [];

    // Add current message to history
    const currentMessage: ContextMessage = {
      role: 'user',
      content: request.prompt,
      tokenCount: this.estimateTokens(request.prompt),
      timestamp: new Date(),
    };

    const updatedHistory = [...sessionHistory, currentMessage];

    // Check if compression is needed
    const totalTokens = updatedHistory.reduce((sum, m) => sum + (m.tokenCount || 0), 0);
    const compressedHistory =
      totalTokens > MAX_TOKENS * COMPRESSION_THRESHOLD
        ? this.compress(updatedHistory)
        : updatedHistory;

    // Persist updated context
    sessionStore.set(request.sessionId, compressedHistory);

    // ---- Stage F: knowledge grounding (MIP-015) ----
    //
    // Additive in the strictest sense: when no provider is attached, `systemPrompt`
    // is byte-identical to what this plane produced before Stage F existed. The
    // grounding is APPENDED to the system prompt rather than merged into the message
    // history, because the retrieved region must stay outside the conversation: a
    // data region placed among user messages would be indistinguishable from
    // something the user said.
    let systemPrompt = request.context?.systemPrompt || this.buildSystemPrompt();

    if (this.knowledgeProvider !== null) {
      // CONTAINED. The provider contract states that it returns a value on every path
      // and raises nothing, and the supplied implementation honours that — but a
      // contract is not an enforcement mechanism, and this boundary is the one place
      // where a violation costs the whole request.
      //
      // Found by the end-to-end suite, not by the unit suites: they exercised a
      // well-behaved provider, so nothing failed. A DEFECTIVE provider — a different
      // embedding backend, a client with an unhandled rejection path — previously
      // propagated straight out of the inference pipeline, and the symptom would have
      // been total inference failure attributed to R-Context rather than to knowledge.
      //
      // Grounding is an ENRICHMENT: the model could have answered without it. Denying
      // an answer because an optional input failed is the wrong trade at any price.
      try {
        const contribution = await this.knowledgeProvider.provide({
          query: request.prompt,
          // No ceiling is asserted here. The provider's own default applies, and
          // R-Context has no basis for widening it: it does not know the requester's
          // clearance, and inventing one would be an authorisation decision taken
          // without the information needed to take it.
        });

        if (contribution.grounded && contribution.dataRegion !== null) {
          this.groundedRequests += 1;
          systemPrompt = `${systemPrompt}\n\n${contribution.dataRegion}`;
          logger.info(
            `R-Context: grounded with ${contribution.sourceCount} source(s), ` +
              `complete=${contribution.complete}`
          );
        } else {
          this.ungroundedRequests += 1;
          // Recorded, not raised. An ungrounded request is a normal outcome — an empty
          // corpus produces one on every request — and it must not read as an error.
          logger.debug(
            `R-Context: proceeding ungrounded (${contribution.reason ?? 'unknown'})`
          );
        }
      } catch (error) {
        this.ungroundedRequests += 1;
        // Logged at ERROR, because a raising provider is a DEFECT and not a normal
        // degradation — the two must be distinguishable in a log or the defect will
        // never be noticed. The request continues regardless.
        //
        // The message is recorded but is NOT placed in the system prompt: an exception
        // string is attacker-influenceable in the general case, and a prompt is the
        // last place it belongs.
        logger.error(
          'R-Context: knowledge provider RAISED, which its contract forbids; ' +
            `proceeding ungrounded (${error instanceof Error ? error.message : 'unknown'})`
        );
      }
    }

    return {
      ...request,
      context: {
        messages: compressedHistory,
        systemPrompt,
        maxTokens: MAX_TOKENS,
        compressionEnabled: true,
      },
    };
  }

  private compress(messages: ContextMessage[]): ContextMessage[] {
    // Keep system message + last 20 messages + always keep first user message
    if (messages.length <= 20) return messages;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const recentMessages = messages.slice(-18);

    logger.info(`Context compressed: ${messages.length} → ${systemMessages.length + recentMessages.length} messages`);

    return [
      ...systemMessages,
      {
        role: 'system',
        content: `[Context compressed: ${messages.length - recentMessages.length} earlier messages summarised]`,
        tokenCount: 20,
        timestamp: new Date(),
      },
      ...recentMessages,
    ];
  }

  private buildSystemPrompt(): string {
    return `You are RONOR, a Sovereign Generative Intelligence Runtime built by Ma11AI (Mayleven Ecosystem).
You operate with evidence-governed reasoning, sovereignty-aware processing, and transparent decision-making.
Every response you generate is scored by the EMS formula: Quality − Cost − Latency − Risk + Sovereignty + Evidence.
Be precise, evidence-grounded, and transparent about your reasoning.`;
  }

  private estimateTokens(text: string): number {
    // Rough approximation: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-context',
      status: 'healthy',
      latencyMs: 1,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
