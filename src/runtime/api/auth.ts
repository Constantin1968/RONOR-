/**
 * RONOR Runtime — L0 · Authentication
 * ───────────────────────────────────
 * API-key authentication with hashed storage, scopes, roles and per-key rate
 * limits. Deliberately simple — this is the first authentication layer, not the
 * last — but simple in the ways that are safe and strict in the ways that matter.
 *
 * Four properties:
 *
 *   1. SECRETS ARE NEVER STORED. Only `sha256(secret)` is persisted. A database
 *      disclosure therefore leaks the ability to recognise a key, not the
 *      ability to use one.
 *   2. COMPARISON IS CONSTANT-TIME. `timingSafeEqual` over the digests. A string
 *      `===` on a credential leaks its prefix through response timing, and while
 *      the attack is fiddly over a network it is free to eliminate.
 *   3. THE BOOTSTRAP KEY IS EXPLICIT AND WARNED ABOUT. A runtime with no keys
 *      configured is unusable, so `RONOR_API_KEYS` seeds keys at boot. If the
 *      value is left at the shipped default, the runtime logs a warning on every
 *      boot and the health endpoint reports `insecure-default-key`. Silence about
 *      a default credential is how demonstration systems reach production.
 *   4. AUTHENTICATION FAILURES ARE UNIFORM. Unknown key, wrong key, revoked key
 *      and disabled key all return the same 401 body. Distinguishing them would
 *      let an attacker enumerate valid key identifiers.
 *
 * Prepared by AMB.
 */

import crypto from 'crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from '../ledgers/schema';

export type ApiRole = 'architect' | 'admin' | 'operator' | 'readonly';

/** The shipped default. Its presence is a reportable security finding. */
export const INSECURE_DEFAULT_KEY = 'ronor-dev-key-change-in-production';

export interface ApiKeyRecord {
  key_id: string;
  label: string;
  role: ApiRole;
  scopes: string[];
  rate_limit_rpm: number;
  active: boolean;
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time digest comparison. */
export function digestsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function upsertApiKey(params: {
  secret: string;
  label: string;
  role?: ApiRole;
  scopes?: string[];
  rateLimitRpm?: number;
}): ApiKeyRecord {
  ensureRuntimeLedgerSchema();
  const hash = hashSecret(params.secret);
  // The key id is a stable, non-secret handle derived from the digest, so a log
  // line can identify which credential acted without ever containing one.
  const keyId = `key_${hash.slice(0, 12)}`;
  const scopes = params.scopes ?? ['query', 'agent', 'read'];
  const role = params.role ?? 'operator';
  const rpm = params.rateLimitRpm ?? 60;

  // F14: ON CONFLICT must NOT set active=1. A bootstrap re-seed must preserve
  // revokeApiKey — only a fresh INSERT activates a key; reactivation is explicit.
  getDb()
    .prepare(
      `INSERT INTO runtime_api_keys (key_id, key_hash, label, role, scopes, rate_limit_rpm, active)\n       VALUES (?,?,?,?,?,?,1)\n       ON CONFLICT(key_id) DO UPDATE SET\n         label = excluded.label,\n         role = excluded.role,\n         scopes = excluded.scopes,\n         rate_limit_rpm = excluded.rate_limit_rpm`,
    )
    .run(keyId, hash, params.label, role, scopes.join(','), rpm);

  const row = getDb()
    .prepare(`SELECT active FROM runtime_api_keys WHERE key_id = ?`)
    .get(keyId) as { active: number };

  return {
    key_id: keyId,
    label: params.label,
    role,
    scopes,
    rate_limit_rpm: rpm,
    active: row.active === 1,
  };
}

/**
 * Explicitly reactivate a previously revoked key (F14).
 *
 * Upsert preserves `active` on conflict so bootstrap cannot undo revokeApiKey.
 * Call this only when reactivation is intentional and audited.
 */
export function reactivateApiKey(keyId: string): boolean {
  ensureRuntimeLedgerSchema();
  const info = getDb()
    .prepare(`UPDATE runtime_api_keys SET active = 1 WHERE key_id = ?`)
    .run(keyId);
  return info.changes > 0;
}

export function revokeApiKey(keyId: string): boolean {
  ensureRuntimeLedgerSchema();
  const info = getDb()
    .prepare(`UPDATE runtime_api_keys SET active = 0 WHERE key_id = ?`)
    .run(keyId);
  return info.changes > 0;
}

export function listApiKeys(): ApiKeyRecord[] {
  ensureRuntimeLedgerSchema();
  const rows = getDb()
    .prepare(
      `SELECT key_id, label, role, scopes, rate_limit_rpm, active\n         FROM runtime_api_keys ORDER BY id ASC`,
    )
    .all() as Array<{
    key_id: string;
    label: string;
    role: string;
    scopes: string;
    rate_limit_rpm: number;
    active: number;
  }>;
  return rows.map((r) => ({
    key_id: r.key_id,
    label: r.label,
    role: r.role as ApiRole,
    scopes: r.scopes.split(',').filter(Boolean),
    rate_limit_rpm: r.rate_limit_rpm,
    active: r.active === 1,
  }));
}

/**
 * Authenticate a presented secret.
 *
 * Returns null for every failure mode. The caller emits one uniform 401 so that
 * an attacker cannot distinguish "no such key" from "revoked key".
 */
export function authenticate(secret: string): ApiKeyRecord | null {
  if (!secret) return null;
  ensureRuntimeLedgerSchema();
  const presented = hashSecret(secret);

  const rows = getDb()
    .prepare(
      `SELECT key_id, key_hash, label, role, scopes, rate_limit_rpm, active\n         FROM runtime_api_keys WHERE active = 1`,
    )
    .all() as Array<{
    key_id: string;
    key_hash: string;
    label: string;
    role: string;
    scopes: string;
    rate_limit_rpm: number;
    active: number;
  }>;

  // Scan every active row with a constant-time comparison rather than looking up
  // by hash. An indexed lookup would be faster, but it also makes the query
  // itself a timing oracle on the digest, and the active key count in this
  // deployment class is small.
  for (const r of rows) {
    if (digestsEqual(presented, r.key_hash)) {
      getDb()
        .prepare(`UPDATE runtime_api_keys SET last_used_at = datetime('now') WHERE key_id = ?`)
        .run(r.key_id);
      return {
        key_id: r.key_id,
        label: r.label,
        role: r.role as ApiRole,
        scopes: r.scopes.split(',').filter(Boolean),
        rate_limit_rpm: r.rate_limit_rpm,
        active: true,
      };
    }
  }
  return null;
}

/**
 * Minimum estimated strength, in bits, for a credential supplied through the
 * environment. 128 bits is the floor at which an unsalted SHA-256 digest of the
 * key is not a practical offline-guessing target (CodeQL js/insufficient-password-hash
 * is a real finding only for low-entropy secrets) and matches a 32-character hex
 * or 22-character base64url random token.
 */
export const MIN_ENV_KEY_BITS = 128;

/**
 * Conservative strength estimate: length multiplied by log2 of the alphabet the
 * key draws from. A pure hexadecimal key is scored on 16 symbols (hex-32 = 128
 * bits); otherwise the alphabet is the union of the character classes present.
 * A key built from fewer than 8 distinct characters is scored on its distinct
 * characters only, so `aaaa...` or `abab...` cannot pass by length alone.
 */
export function estimateKeyBits(secret: string): number {
  if (!secret) return 0;
  let alphabet = 0;
  if (/^[0-9a-fA-F]+$/.test(secret)) {
    alphabet = 16;
  } else {
    if (/[a-z]/.test(secret)) alphabet += 26;
    if (/[A-Z]/.test(secret)) alphabet += 26;
    if (/[0-9]/.test(secret)) alphabet += 10;
    if (/[^a-zA-Z0-9]/.test(secret)) alphabet += 33;
  }
  const distinct = new Set(secret).size;
  const effective = distinct < 8 ? distinct : alphabet;
  if (effective < 2) return 0;
  return Math.floor(secret.length * Math.log2(effective));
}

export interface BootstrapResult {
  keysSeeded: number;
  /**
   * Environment credentials refused because their estimated strength is below
   * MIN_ENV_KEY_BITS. Only the variable name and position are reported, never the
   * value or the operator-chosen label, so the result is safe to log.
   */
  weakKeysRejected: string[];
  /** True when a shipped default credential is active. */
  insecureDefaultActive: boolean;
}

/**
 * Seed keys from the environment.
 *
 * `RONOR_API_KEYS` accepts `label:secret` pairs separated by commas, or bare
 * secrets which are labelled positionally. `RONOR_ADMIN_API_KEY` seeds a single
 * admin credential with full scopes.
 */
export function bootstrapApiKeys(env: NodeJS.ProcessEnv = process.env): BootstrapResult {
  ensureRuntimeLedgerSchema();
  let seeded = 0;
  let insecure = false;
  const weak: string[] = [];
  // A weak key is refused, not seeded: an unusable credential fails loudly at boot
  // (index.ts logs it and /health reports no key), whereas a guessable one would
  // work silently. The shipped demo key keeps its own, stronger signal below.
  const strong = (secret: string, source: string): boolean => {
    if (secret === INSECURE_DEFAULT_KEY) return true;
    if (estimateKeyBits(secret) >= MIN_ENV_KEY_BITS) return true;
    weak.push(source);
    return false;
  };

  const architect = env.RONOR_ARCHITECT_API_KEY?.trim();
  if (architect && strong(architect, 'RONOR_ARCHITECT_API_KEY')) {
    upsertApiKey({
      secret: architect,
      label: 'merlin',
      role: 'architect',
      scopes: ['architect', 'query', 'agent', 'read', 'admin', 'ingest'],
      rateLimitRpm: Number(env.RONOR_ARCHITECT_RATE_LIMIT_RPM ?? 240),
    });
    seeded++;
    if (architect === INSECURE_DEFAULT_KEY) insecure = true;
  }

  const admin = env.RONOR_ADMIN_API_KEY?.trim();
  if (admin && strong(admin, 'RONOR_ADMIN_API_KEY')) {
    upsertApiKey({
      secret: admin,
      label: 'bootstrap-admin',
      role: 'admin',
      scopes: ['query', 'agent', 'read', 'admin', 'ingest'],
      rateLimitRpm: Number(env.RONOR_ADMIN_RATE_LIMIT_RPM ?? 240),
    });
    seeded++;
    if (admin === INSECURE_DEFAULT_KEY) insecure = true;
  }

  const list = env.RONOR_API_KEYS?.trim();
  if (list) {
    let i = 0;
    for (const raw of list.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      i++;
      const sep = item.indexOf(':');
      const label = sep > 0 ? item.slice(0, sep).trim() : `operator-${i}`;
      const secret = sep > 0 ? item.slice(sep + 1).trim() : item;
      if (!secret) continue;
      if (!strong(secret, `RONOR_API_KEYS[${i}]`)) continue;
      upsertApiKey({
        secret,
        label,
        role: 'operator',
        scopes: ['query', 'agent', 'read'],
        rateLimitRpm: Number(env.RONOR_RATE_LIMIT_RPM ?? 60),
      });
      seeded++;
      if (secret === INSECURE_DEFAULT_KEY) insecure = true;
    }
  }

  // Legacy variable from the Core Active deployment, honoured so an existing
  // .env keeps working rather than locking an operator out after an upgrade.
  const legacy = env.GATEWAY_API_KEY?.trim();
  if (legacy && !list && !admin && strong(legacy, 'GATEWAY_API_KEY')) {
    upsertApiKey({
      secret: legacy,
      label: 'legacy-gateway-key',
      role: 'operator',
      scopes: ['query', 'agent', 'read'],
      rateLimitRpm: Number(env.RATE_LIMIT_RPM ?? 60),
    });
    seeded++;
    if (legacy === INSECURE_DEFAULT_KEY) insecure = true;
  }

  return { keysSeeded: seeded, weakKeysRejected: weak, insecureDefaultActive: insecure };
}

export function hasAnyActiveKey(): boolean {
  ensureRuntimeLedgerSchema();
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM runtime_api_keys WHERE active = 1`)
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Is an insecure shipped default currently active?
 *
 * Reported on the health endpoint so that a deployment running on the demo
 * credential is visibly, continuously flagged rather than discovered later.
 */
export function insecureDefaultActive(): boolean {
  ensureRuntimeLedgerSchema();
  const hash = hashSecret(INSECURE_DEFAULT_KEY);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM runtime_api_keys WHERE active = 1 AND key_hash = ?`)
    .get(hash) as { n: number };
  return row.n > 0;
}

export function hasScope(key: ApiKeyRecord, scope: string): boolean {
  // An admin role implies every scope. Enumerating admin scopes at every call
  // site is how a new endpoint ends up unreachable by the only key that should
  // certainly reach it.
  if (key.role === 'architect') return true;
  // Technical administrators do not inherit the constitutional Architect role.
  if (scope === 'architect') return false;
  return key.role === 'admin' || key.scopes.includes(scope);
}
