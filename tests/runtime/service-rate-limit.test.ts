/**
 * The internal service surfaces are guarded by a static service token. A static
 * token is one guessable secret, so the ingress ceiling is part of the security
 * contract rather than a convenience. These tests assert the two properties that
 * matter and that a refactor could silently lose:
 *
 *   1. the ceiling actually refuses traffic above the limit;
 *   2. two different callers do not share one bucket, so one caller cannot
 *      exhaust another's quota.
 */

import express from 'express';
import request from 'supertest';
import { createServiceRateLimit } from '../../src/runtime/automation/services/rate-limit';

function appWithLimit(limit: number) {
  const app = express();
  app.use(createServiceRateLimit(limit));
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('internal service ingress limiter', () => {
  it('admits traffic up to the ceiling and refuses it above', async () => {
    const app = appWithLimit(3);
    const token = 'Bearer caller-one';

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/probe').set('authorization', token);
      expect(res.status).toBe(200);
    }

    const refused = await request(app).get('/probe').set('authorization', token);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      ok: false,
      error: 'rate_limited',
      scope: 'per-instance',
    });
  });

  it('does not disclose the credential in the refusal', async () => {
    const app = appWithLimit(1);
    const token = 'Bearer a-secret-service-token';

    await request(app).get('/probe').set('authorization', token);
    const refused = await request(app).get('/probe').set('authorization', token);

    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).not.toContain('a-secret-service-token');
  });

  it('meters each caller separately rather than pooling them', async () => {
    const app = appWithLimit(1);

    const first = await request(app).get('/probe').set('authorization', 'Bearer caller-one');
    expect(first.status).toBe(200);

    // A different caller must still have its full quota.
    const second = await request(app).get('/probe').set('authorization', 'Bearer caller-two');
    expect(second.status).toBe(200);

    // ...while the first caller is now over its own ceiling.
    const firstAgain = await request(app).get('/probe').set('authorization', 'Bearer caller-one');
    expect(firstAgain.status).toBe(429);
  });
});
