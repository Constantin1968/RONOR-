/**
 * SHA-256 hash-chain unit tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { append, verifyChain, getHeadHash, countRecords, closeDb, sha256, canonicalStringify } from '../../src/audit/hash-chain';
import { loadPolicy, evaluate } from '../../src/governance/mi9-gate';

// Use a scratch DB per test run
const scratchDb = path.join(os.tmpdir(), `ronor-audit-test-${Date.now()}.db`);
process.env.AUDIT_DB_PATH = scratchDb;

function makePayload(id: string) {
  return {
    decisionId: id,
    decisionType: 'energy.bess.dispatch',
    timestamp: new Date().toISOString(),
    context: {
      decisionId: id,
      domain: 'energy.bess.dispatch',
      action: 'test',
      proposedBy: 'test-model',
      confidence: 0.9,
      reversible: true,
      impactMagnitude: { unit: 'EUR' as const, value: 100 },
      sovereignty: { dataResidency: 'eu' as const, subjectJurisdiction: 'RO' as const },
      evidence: { sourceCount: 3, lastRefreshMs: 30000, consensusReached: true },
      operator: { role: 'operator' as const },
      metadata: { fallbackAvailable: true },
    },
    mi9Result: evaluate({
      decisionId: id,
      domain: 'energy.bess.dispatch',
      action: 'test',
      proposedBy: 'test-model',
      confidence: 0.9,
      reversible: true,
      impactMagnitude: { unit: 'EUR' as const, value: 100 },
      sovereignty: { dataResidency: 'eu' as const, subjectJurisdiction: 'RO' as const },
      evidence: { sourceCount: 3, lastRefreshMs: 30000, consensusReached: true },
      operator: { role: 'operator' as const },
      metadata: { fallbackAvailable: true },
    }),
    aiProposal: { model: 'test-model', rationale: 'test' },
    outcome: { action: 'executed' as const, unit: 'EUR' },
  };
}

beforeAll(() => {
  loadPolicy();
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(scratchDb)) fs.unlinkSync(scratchDb);
});

describe('SHA-256 hash chain', () => {
  test('canonical stringify is deterministic', () => {
    const a = { z: 1, a: 2, nested: { y: 3, x: 4 } };
    const b = { a: 2, z: 1, nested: { x: 4, y: 3 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test('SHA-256 basic vector', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  test('appends and links records', () => {
    const r1 = append(makePayload('t1'));
    const r2 = append(makePayload('t2'));
    const r3 = append(makePayload('t3'));

    expect(r1.prevHash).toBe('0'.repeat(64));
    expect(r2.prevHash).toBe(r1.chainHash);
    expect(r3.prevHash).toBe(r2.chainHash);
    expect(getHeadHash()).toBe(r3.chainHash);
    expect(countRecords()).toBeGreaterThanOrEqual(3);
  });

  test('verifyChain succeeds on a clean chain', () => {
    const r = verifyChain();
    expect(r.ok).toBe(true);
    expect(r.totalRecords).toBeGreaterThanOrEqual(3);
  });

  test('verifyChain detects payload tampering', () => {
    // Directly mutate the SQLite DB to simulate tampering
    const Database = require('better-sqlite3');
    const db = new Database(scratchDb);
    db.prepare('UPDATE audit_chain SET payload_json = ? WHERE seq = 1').run(
      '{"tampered": true}'
    );
    db.close();

    const r = verifyChain();
    expect(r.ok).toBe(false);
    expect(r.brokenAtSeq).toBe(1);
    expect(r.brokenReason).toMatch(/hash mismatch/i);
  });
});
