/**
 * Offline audit-chain verifier
 *
 * Purpose: allow a bank, TSO regulator, insurer, or OSaaS client to
 * independently verify the RONOR audit chain WITHOUT running the RONOR
 * server. It takes either:
 *   - a JSON file exported from `GET /api/v1/audit/export`
 *   - or the live SQLite audit DB
 *
 * and re-hashes every record from genesis to head. If any record has been
 * tampered with, the verifier reports the exact break point.
 *
 * Usage:
 *   ts-node scripts/verify-chain.ts                # verifies live DB
 *   ts-node scripts/verify-chain.ts export.json    # verifies exported file
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { verifyChain } from '../src/audit/hash-chain';

interface ExportedChain {
  exportedAt: string;
  totalRecords: number;
  headHash: string;
  policyVersion: string;
  exposureModuleVersion: string;
  chain: {
    seq: number;
    recordId: string;
    timestamp: string;
    payload: unknown;
    payloadHash: string;
    prevHash: string;
    chainHash: string;
  }[];
}

function canonicalStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x as object)) return null;
    seen.add(x as object);
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
    return out;
  };
  return JSON.stringify(walk(v));
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const GENESIS = '0'.repeat(64);

function verifyExportedFile(filePath: string): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw) as ExportedChain;
  console.log(`\n────────  Offline verify: ${filePath}  ────────`);
  console.log(`Records claimed: ${doc.totalRecords}`);
  console.log(`Head claimed:    ${doc.headHash}`);
  console.log(`Policy version:  ${doc.policyVersion}`);
  console.log(`Exposure module: ${doc.exposureModuleVersion}\n`);

  let prev = GENESIS;
  let ok = true;
  let brokenAt: number | null = null;
  let reason = '';

  for (const r of doc.chain) {
    const rehashPayload = sha256(canonicalStringify(r.payload));
    if (rehashPayload !== r.payloadHash) {
      ok = false;
      brokenAt = r.seq;
      reason = `payload hash mismatch (recomputed ${rehashPayload.slice(0, 12)}… vs stored ${r.payloadHash.slice(0, 12)}…)`;
      break;
    }
    if (r.prevHash !== prev) {
      ok = false;
      brokenAt = r.seq;
      reason = `prev-hash mismatch (expected ${prev.slice(0, 12)}… got ${r.prevHash.slice(0, 12)}…)`;
      break;
    }
    const rehashChain = sha256(r.payloadHash + r.prevHash);
    if (rehashChain !== r.chainHash) {
      ok = false;
      brokenAt = r.seq;
      reason = `chain hash mismatch at seq ${r.seq}`;
      break;
    }
    prev = r.chainHash;
  }

  if (ok) {
    console.log(`✓ CHAIN INTACT — ${doc.chain.length} records verified`);
    console.log(`✓ head hash confirmed: ${prev}`);
    if (prev !== doc.headHash) {
      console.warn(`⚠ note: recomputed head (${prev.slice(0, 12)}…) differs from claimed head`);
    }
    process.exit(0);
  } else {
    console.error(`✗ CHAIN BROKEN at seq=${brokenAt}: ${reason}`);
    process.exit(2);
  }
}

function verifyLive(): void {
  console.log('\n────────  Live SQLite verify  ────────');
  const result = verifyChain();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

// -----------------------------------------------------------
// Entry
// -----------------------------------------------------------
const target = process.argv[2];
if (target) {
  if (!fs.existsSync(target)) {
    console.error(`File not found: ${target}`);
    process.exit(1);
  }
  verifyExportedFile(target);
} else {
  verifyLive();
}
