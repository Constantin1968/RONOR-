/**
 * F01 + F14 acceptance — auth middleware wiring and revoke-preserving upsert.
 *
 * F14: upsertApiKey ON CONFLICT must preserve active (bootstrap must not undo
 *      revokeApiKey). Explicit reactivateApiKey() is the only reactivation path.
 * F01: /api/v1 mounts requireAuth (+ ingressRateLimit); GET /health stays public.
 *      Cosign prefers authenticated key label/id over body.operator.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authenticate,
  listApiKeys,
  reactivateApiKey,
  revokeApiKey,
  upsertApiKey,
} from '../../src/runtime/api/auth';

describe('F14 · upsertApiKey must not reactivate revoked keys', () => {
  const secret = 'f14-revoke-preserve-secret-0123456789abcdef';

  it('preserves active=0 on ON CONFLICT after revokeApiKey', () => {
    const created = upsertApiKey({
      secret,
      label: 'f14-preserve',
      role: 'operator',
      scopes: ['query', 'read'],
    });
    expect(created.active).toBe(true);
    expect(authenticate(secret)).not.toBeNull();

    expect(revokeApiKey(created.key_id)).toBe(true);
    expect(authenticate(secret)).toBeNull();
    const revoked = listApiKeys().find((k) => k.key_id === created.key_id);
    expect(revoked?.active).toBe(false);

    // Bootstrap-style re-seed: same secret, updated label — must NOT reactivate.
    const reseeds = upsertApiKey({
      secret,
      label: 'f14-reseeded-label',
      role: 'operator',
      scopes: ['query', 'read', 'agent'],
    });
    expect(reseeds.key_id).toBe(created.key_id);
    expect(reseeds.active).toBe(false);
    expect(authenticate(secret)).toBeNull();

    const after = listApiKeys().find((k) => k.key_id === created.key_id);
    expect(after?.active).toBe(false);
    expect(after?.label).toBe('f14-reseeded-label');
  });

  it('reactivates only via explicit reactivateApiKey()', () => {
    const rec = listApiKeys().find((k) => k.label === 'f14-reseeded-label');
    expect(rec).toBeDefined();
    expect(rec!.active).toBe(false);

    expect(reactivateApiKey(rec!.key_id)).toBe(true);
    expect(authenticate(secret)?.label).toBe('f14-reseeded-label');

    // Clean up so later suites are not polluted by this key.
    revokeApiKey(rec!.key_id);
  });
});

describe('F01 · /api/v1 auth middleware wiring', () => {
  const indexSrc = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  const routerSrc = readFileSync(join(process.cwd(), 'src/api/router.ts'), 'utf8');

  it('imports requireAuth and ingressRateLimit for /api/v1', () => {
    expect(indexSrc).toMatch(/ingressRateLimit/);
    expect(indexSrc).toMatch(/requireAuth/);
    expect(indexSrc).toMatch(
      /app\.use\(\s*['"]\/api\/v1['"]\s*,\s*ingressRateLimit\s*,\s*provenanceMiddleware\s*,\s*requireAuth\(\s*['"]read['"]\s*\)\s*\)/,
    );
  });

  it('keeps top-level GET /health public (not behind requireAuth)', () => {
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/health['"]/);
    // The public health handler must not sit on the authenticated /api/v1 chain.
    const healthIdx = indexSrc.indexOf("app.get('/health'");
    const altHealthIdx = indexSrc.indexOf('app.get("/health"');
    const idx = healthIdx >= 0 ? healthIdx : altHealthIdx;
    expect(idx).toBeGreaterThan(-1);
    const slice = indexSrc.slice(Math.max(0, idx - 80), idx);
    expect(slice).not.toMatch(/requireAuth/);
  });

  it('cosign prefers authenticated key identity over body.operator', () => {
    expect(routerSrc).toMatch(/req\.apiKey\?\.label/);
    expect(routerSrc).toMatch(/req\.apiKey\?\.key_id/);
    // Must not gate solely on body.operator anymore.
    expect(routerSrc).not.toMatch(
      /if\s*\(\s*!body\.recordId\s*\|\|\s*!body\.operator\s*\)/,
    );
  });
});
