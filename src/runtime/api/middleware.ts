/**
 * RONOR Runtime — L0 · Middleware
 * ───────────────────────────────
 * Authentication, rate limiting, provenance capture and error containment for
 * the unified request surface.
 *
 * Provenance is the part that distinguishes this from ordinary API middleware.
 * Every request acquires a provenance record at the boundary — request id,
 * authenticated key id, client address, received timestamp, sanitisation verdict
 * — and that record is attached to the request object so that every downstream
 * layer writes the SAME identifiers into the work ledger, the audit chain and
 * the response. An identifier minted separately in three places is three
 * identifiers, and reconciling them afterwards is guesswork.
 *
 * The rate limiter is per-key and in-process. That is honest about its scope: it
 * protects a single instance from a single misbehaving client. It is not a
 * distributed quota, and a multi-instance deployment needs a shared store; the
 * limiter says so in its own response headers rather than implying a guarantee
 * it cannot make.
 *
 * Prepared by AMB.
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { authenticate, hasScope, type ApiKeyRecord } from './auth';

export interface Provenance {
  request_id: string;
  received_at: string;
  client_ip: string;
  user_agent: string | null;
  api_key_id: string | null;
  api_key_label: string | null;
  role: string | null;
  /** Populated by route handlers after sanitisation. */
  sanitisation_verdict?: string;
  sanitisation_findings?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      provenance?: Provenance;
      apiKey?: ApiKeyRecord;
    }
  }
}

export function newRequestId(): string {
  // Prefixed and time-ordered: an operator reading a ledger can sort by id and
  // get chronological order without parsing a timestamp column.
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function provenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provenance: Provenance = {
    request_id: newRequestId(),
    received_at: new Date().toISOString(),
    // `x-forwarded-for` is only trustworthy behind a proxy that sets it. It is
    // recorded as reported rather than treated as verified.
    client_ip:
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown',
    user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
    api_key_id: null,
    api_key_label: null,
    role: null,
  };
  req.provenance = provenance;
  res.setHeader('X-RONOR-Request-Id', provenance.request_id);
  next();
}

function extractSecret(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-ronor-api-key'];
  if (typeof header === 'string') return header.trim();
  return '';
}

/**
 * Require a valid API key carrying `scope`.
 *
 * Every failure returns the same body. Distinguishing "unknown key" from
 * "revoked key" would let an attacker enumerate valid key identifiers, and the
 * operator-facing detail belongs in the server log, not the response.
 */
export function requireAuth(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = extractSecret(req);
    const key = secret ? authenticate(secret) : null;

    if (!key) {
      res.status(401).json({
        ok: false,
        error: 'unauthorized',
        message:
          'A valid API key is required. Supply it as `Authorization: Bearer <key>` or `X-RONOR-API-Key: <key>`.',
        request_id: req.provenance?.request_id,
      });
      return;
    }

    if (!hasScope(key, scope)) {
      res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: `This key lacks the '${scope}' scope.`,
        required_scope: scope,
        granted_scopes: key.scopes,
        request_id: req.provenance?.request_id,
      });
      return;
    }

    req.apiKey = key;
    if (req.provenance) {
      req.provenance.api_key_id = key.key_id;
      req.provenance.api_key_label = key.label;
      req.provenance.role = key.role;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export function resetRateLimiter(): void {
  buckets.clear();
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.apiKey;
  if (!key) {
    next();
    return;
  }
  const now = Date.now();
  let bucket = buckets.get(key.key_id);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key.key_id, bucket);
  }
  bucket.count++;

  const limit = key.rate_limit_rpm;
  const remaining = Math.max(0, limit - bucket.count);
  const resetSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(resetSeconds));
  // Declared explicitly so no operator mistakes a per-instance limiter for a
  // cluster-wide quota.
  res.setHeader('X-RateLimit-Scope', 'per-instance');

  if (bucket.count > limit) {
    res.status(429).json({
      ok: false,
      error: 'rate_limited',
      message: `Rate limit of ${limit} requests per minute exceeded for this key.`,
      retry_after_seconds: resetSeconds,
      scope: 'per-instance',
      request_id: req.provenance?.request_id,
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Error containment
// ---------------------------------------------------------------------------

/**
 * Terminal error handler.
 *
 * Returns a stable shape and never leaks a stack trace to the client. The stack
 * goes to the server log with the request id, so an operator can correlate a user
 * complaint to a specific failure without the failure itself being disclosed.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.provenance?.request_id ?? 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[RONOR:L0] unhandled error on ${req.method} ${req.path} (${requestId}):`, err);
  if (res.headersSent) return;
  res.status(500).json({
    ok: false,
    error: 'internal_error',
    message: 'The runtime encountered an unexpected error. The failure has been logged.',
    detail: process.env.NODE_ENV === 'production' ? undefined : message,
    request_id: requestId,
  });
}

/** Wrap an async handler so a rejected promise reaches `errorHandler`. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
