/**
 * Key-strength floor for operator-supplied credentials (CodeQL #13 closure).
 * Secrets are generated at run time so no fixed credential-shaped string is
 * committed to the repository.
 */
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'ronor-key-entropy-'));
process.env.AUDIT_DB_PATH = join(dir, 'audit.db');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auth = require('../../src/runtime/api/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { closeDb } = require('../../src/audit/hash-chain');

afterAll(() => {
  try { closeDb(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('estimateKeyBits', () => {
  it('scores random hex-32 and base64url-24 at or above the floor', () => {
    expect(auth.estimateKeyBits(randomBytes(16).toString('hex'))).toBeGreaterThanOrEqual(auth.MIN_ENV_KEY_BITS);
    expect(auth.estimateKeyBits(randomBytes(24).toString('base64url'))).toBeGreaterThanOrEqual(auth.MIN_ENV_KEY_BITS);
  });
  it('scores long repetitions and short keys below the floor', () => {
    expect(auth.estimateKeyBits('a'.repeat(64))).toBe(0);
    expect(auth.estimateKeyBits('ab'.repeat(40))).toBeLessThan(auth.MIN_ENV_KEY_BITS);
    expect(auth.estimateKeyBits('short-key-1')).toBeLessThan(auth.MIN_ENV_KEY_BITS);
    expect(auth.estimateKeyBits('')).toBe(0);
  });
});

describe('bootstrapApiKeys strength floor', () => {
  it('refuses weak environment keys, reports only their source, and seeds strong ones', () => {
    const strong = randomBytes(32).toString('hex');
    const r = auth.bootstrapApiKeys({
      RONOR_ADMIN_API_KEY: 'x'.repeat(40),
      RONOR_API_KEYS: `good:${strong},bad:${'1'.repeat(30)}`,
    });
    expect(r.keysSeeded).toBe(1);
    expect(r.weakKeysRejected).toEqual(['RONOR_ADMIN_API_KEY', 'RONOR_API_KEYS[2]']);
    expect(JSON.stringify(r)).not.toContain('x'.repeat(40));
  });
  it('still flags the shipped demo key instead of silently refusing it', () => {
    const r = auth.bootstrapApiKeys({ RONOR_ADMIN_API_KEY: auth.INSECURE_DEFAULT_KEY });
    expect(r.insecureDefaultActive).toBe(true);
    expect(r.weakKeysRejected).toEqual([]);
  });
});
