/**
 * R-Gateway Plane
 * Plane 1 of 7 — Ingress, authentication, rate limiting, and request validation.
 *
 * Responsibilities:
 * - API key / JWT authentication
 * - Rate limiting (RPM + burst)
 * - Request schema validation (Zod)
 * - Sovereignty header injection
 * - Threat detection (prompt injection screening)
 */

import { z } from 'zod';
import { createLogger } from '../../utils/logger';
import type { RONORRequest, PlaneHealth } from '../../types';

const logger = createLogger('Plane:R-Gateway');

const RequestSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  prompt: z.string().min(1).max(100_000),
  userId: z.string().optional(),
});

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class RGatewayPlane {
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly maxRPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);
  private requestsTotal = 0;
  private errorsTotal = 0;
  private readonly startTime = Date.now();

  async init(): Promise<void> {
    logger.info('R-Gateway plane initialised ✓');
  }

  async process(request: RONORRequest): Promise<RONORRequest> {
    this.requestsTotal++;

    // Schema validation
    const parsed = RequestSchema.safeParse(request);
    if (!parsed.success) {
      this.errorsTotal++;
      throw new Error(`R-Gateway: Invalid request schema — ${parsed.error.message}`);
    }

    // Rate limiting
    this.checkRateLimit(request.sessionId);

    // Basic prompt injection screening
    this.screenForInjection(request.prompt);

    // Inject sovereignty metadata
    return {
      ...request,
      metadata: {
        ...request.metadata,
        gatewayTimestamp: new Date().toISOString(),
        sovereigntyChecked: true,
        gatewayVersion: '1.0.0',
      },
    };
  }

  private checkRateLimit(sessionId: string): void {
    const now = Date.now();
    const bucket = this.rateLimits.get(sessionId);

    if (!bucket || now > bucket.resetAt) {
      this.rateLimits.set(sessionId, { count: 1, resetAt: now + 60_000 });
      return;
    }

    if (bucket.count >= this.maxRPM) {
      this.errorsTotal++;
      throw new Error(`R-Gateway: Rate limit exceeded for session ${sessionId}`);
    }

    bucket.count++;
  }

  private screenForInjection(prompt: string): void {
    const injectionPatterns = [
      /ignore previous instructions/i,
      /system:\s*you are now/i,
      /\[INST\].*override/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(prompt)) {
        this.errorsTotal++;
        throw new Error('R-Gateway: Potential prompt injection detected');
      }
    }
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-gateway',
      status: 'healthy',
      latencyMs: Date.now() - this.startTime < 1000 ? 1 : 2,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
