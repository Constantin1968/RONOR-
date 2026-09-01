/**
 * RONOR Automation — shared ingress limiter for the internal service surfaces
 * ──────────────────────────────────────────────────────────────────────────
 * The verification authorities, the evidence runner, the OpenHands bridge and
 * the model egress proxy each expose a small HTTP surface guarded by a static
 * service token. A static token is a single guessable secret: without a limiter,
 * an attacker on the service network can attempt it without bound, and a
 * malfunctioning caller can exhaust a downstream provider budget in a loop.
 *
 * These surfaces are internal and low-volume by design, so the quota is a flat
 * per-caller ceiling rather than the per-credential quota used on the public
 * runtime API. The intent is to bound abuse, not to meter legitimate service
 * traffic — the ceiling sits far above any honest caller's rate.
 *
 * The limiter is per-instance and in-process. It protects one process from one
 * misbehaving caller; it is not a cluster-wide quota, and it says so in its own
 * response rather than implying a guarantee it cannot make.
 */

import crypto from 'crypto';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';

/** One minute, matching the runtime API window so operators reason about one unit. */
const WINDOW_MS = 60_000;

/** Far above any honest internal caller; low enough to bound a hostile loop. */
const DEFAULT_LIMIT = 240;

/**
 * Builds an ingress limiter for an internal service application.
 *
 * Callers are distinguished by their service token rather than by address,
 * because several services legitimately share one address inside a container
 * network, and pooling them into one bucket would let one starve the others.
 * The token is never stored or logged — only a short digest of it is used as a
 * bucket label, so the limiter cannot become a place a credential leaks from.
 */
export function createServiceRateLimit(limit: number = DEFAULT_LIMIT): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const authorisation = req.header('authorization');
      if (!authorisation) return ipKeyGenerator(req.ip ?? '');
      // A digest, not the credential. Truncated because collision resistance is
      // irrelevant for a bucket label and short labels keep the store small.
      return `tok:${digest(authorisation)}`;
    },
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: `Rate limit of ${limit} requests per minute exceeded for this caller.`,
        scope: 'per-instance',
      });
    },
  });
}

/**
 * A bucket label derived from the credential, never the credential itself.
 * Truncated because collision resistance is irrelevant for a label and short
 * labels keep the store small.
 */
function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
