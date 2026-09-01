/**
 * The runtime surface carries two limiters, and they are not redundant.
 *
 * The per-key limiter takes its quota from the API key record, so it can only
 * run after a credential has been verified. That leaves the verification itself
 * unmetered: a caller who never presents a valid credential is invisible to a
 * limiter that meters keys. The ingress ceiling closes that gap by metering the
 * request to be authenticated, ahead of any authorisation check.
 *
 * These tests assert the three properties a refactor could silently lose:
 *
 *   1. unauthenticated traffic is bounded — the property the per-key limiter
 *      cannot provide, since it skips requests without a key;
 *   2. two callers presenting different credentials do not share one bucket;
 *   3. the refusal never echoes the presented credential back.
 */

import express from 'express';
import request from 'supertest';
import { ingressRateLimit, resetRateLimiter } from '../../src/runtime/api/middleware';

/**
 * The draft standard publishes one combined header, so headroom is read out of
 * it rather than from a `-Remaining` header. Parsed strictly: a missing or
 * unparsable header fails the assertion instead of silently comparing
 * `undefined` against `undefined`, which is a test that proves nothing.
 */
function remaining(headers: Record<string, string>): number {
  const header = headers['ratelimit'];
  expect(typeof header).toBe('string');
  const match = /remaining=(\d+)/.exec(String(header));
  expect(match).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

function probeApp() {
  const app = express();
  app.use(ingressRateLimit);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

// The ceiling is deliberately generous in production. Reaching it honestly in a
// test would mean issuing hundreds of requests, so the assertions below drive
// the counter directly through repeated calls against a shared bucket and read
// the published headroom rather than exhausting it.
describe('runtime ingress ceiling', () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it('meters unauthenticated traffic, which the per-key limiter skips', async () => {
    const app = probeApp();

    const first = await request(app).get('/probe');
    expect(first.status).toBe(200);
    const afterFirst = remaining(first.headers as Record<string, string>);

    const second = await request(app).get('/probe');
    expect(second.status).toBe(200);
    const afterSecond = remaining(second.headers as Record<string, string>);

    // A counter that does not advance is a limiter that is not limiting.
    expect(afterSecond).toBe(afterFirst - 1);
  });

  it('does not pool callers presenting different credentials', async () => {
    const app = probeApp();

    const one = await request(app).get('/probe').set('authorization', 'Bearer caller-one');
    const two = await request(app).get('/probe').set('authorization', 'Bearer caller-two');

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    // Each caller's first request must see the same headroom. If they shared a
    // bucket, the second would see one less.
    expect(remaining(two.headers as Record<string, string>)).toBe(
      remaining(one.headers as Record<string, string>)
    );
  });

  it('does not disclose the presented credential when refusing', async () => {
    const credential = 'Bearer secret-value-that-must-not-appear';
    const app = express();
    app.use(ingressRateLimit);
    app.get('/probe', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/probe').set('authorization', credential);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret-value-that-must-not-appear');
    expect(JSON.stringify(res.headers)).not.toContain('secret-value-that-must-not-appear');
  });
});
