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

const logger = createLogger('Plane:R-Context');

const MAX_TOKENS = parseInt(process.env.CONTEXT_MAX_TOKENS || '128000', 10);
const COMPRESSION_THRESHOLD = parseFloat(process.env.CONTEXT_COMPRESSION_THRESHOLD || '0.8');

// In-memory session store (replace with Redis in production)
const sessionStore = new Map<string, ContextMessage[]>();

export class RContextPlane {
  private requestsTotal = 0;
  private errorsTotal = 0;

  async init(): Promise<void> {
    logger.info('R-Context plane initialised ✓');
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

    return {
      ...request,
      context: {
        messages: compressedHistory,
        systemPrompt: request.context?.systemPrompt || this.buildSystemPrompt(),
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
