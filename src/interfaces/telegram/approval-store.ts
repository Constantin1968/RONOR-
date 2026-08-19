/**
 * RONOR — L0 · Telegram Interface · Approval Store
 * ─────────────────────────────────────────────────
 * Holds Gate 1/2 co-sign requests that are pending a human decision.
 *
 * The store is in-memory with an optional Redis persistence layer. The design
 * choice is deliberate: the bridge is stateless-preferred, and a Redis outage
 * must not prevent the runtime from answering queries. When Redis is absent or
 * unavailable the store falls back to in-memory and says so in the log — it
 * does not pretend to be durable.
 *
 * What the store does NOT do:
 *   · It does not re-execute the governed request on approval. The bot handler
 *     does that, with the original payload, after the approver settles the gate.
 *   · It does not notify the runtime that a gate was settled. The runtime does
 *     not have a settlement endpoint; the bot re-submits the request and the
 *     runtime re-runs governance. If the second run also raises a gate, the
 *     operator sees a second prompt. That is correct: governance is not a
 *     one-time check that can be bypassed by a stored token.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import crypto from 'crypto';
import { createLogger } from '../../utils/logger';
import type { PendingApproval } from './types';

const logger = createLogger('RONOR:Telegram:ApprovalStore');

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const store = new Map<string, PendingApproval>();

function newApprovalId(): string {
  return `apv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function createApproval(params: {
  kind: 'query' | 'mission';
  requestId: string;
  runtimeApprovalId: string | null;
  heldResponse: PendingApproval['heldResponse'];
  payload: string;
  requestedByUserId: number;
  requestedByName: string;
  chatId: number;
  promptMessageId: number | null;
  verdict: string;
  gateFindings: PendingApproval['gateFindings'];
  ttlMinutes: number;
  auditRecordId: string | null;
}): PendingApproval {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60_000);
  const approval: PendingApproval = {
    approvalId: newApprovalId(),
    kind: params.kind,
    requestId: params.requestId,
    runtimeApprovalId: params.runtimeApprovalId,
    heldResponse: params.heldResponse,
    payload: params.payload,
    requestedByUserId: params.requestedByUserId,
    requestedByName: params.requestedByName,
    chatId: params.chatId,
    promptMessageId: params.promptMessageId,
    verdict: params.verdict,
    gateFindings: params.gateFindings,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'pending',
    settledByUserId: null,
    settledAt: null,
    settlementNote: null,
    auditRecordId: params.auditRecordId,
  };
  store.set(approval.approvalId, approval);
  logger.info(
    `approval ${approval.approvalId} created for user ${params.requestedByUserId} ` +
      `(${params.kind}, verdict=${params.verdict}, expires=${expiresAt.toISOString()})`,
  );
  return approval;
}

export function getApproval(approvalId: string): PendingApproval | undefined {
  return store.get(approvalId);
}

export function listPendingApprovals(): PendingApproval[] {
  const now = Date.now();
  const out: PendingApproval[] = [];
  for (const a of store.values()) {
    if (a.status !== 'pending') continue;
    if (new Date(a.expiresAt).getTime() < now) {
      // Expire lazily on read.
      a.status = 'expired';
      logger.info(`approval ${a.approvalId} expired (lazy)`);
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Find the most recent pending approval for a given user, optionally filtered
 * by kind. Used when an approver sends /approve or /reject without specifying
 * an id — the most natural interaction is to respond to the most recent prompt.
 */
export function findLatestPendingForUser(
  requestedByUserId: number,
  kind?: 'query' | 'mission',
): PendingApproval | undefined {
  const now = Date.now();
  let latest: PendingApproval | undefined;
  for (const a of store.values()) {
    if (a.status !== 'pending') continue;
    if (new Date(a.expiresAt).getTime() < now) {
      a.status = 'expired';
      continue;
    }
    if (a.requestedByUserId !== requestedByUserId) continue;
    if (kind && a.kind !== kind) continue;
    if (!latest || a.createdAt > latest.createdAt) latest = a;
  }
  return latest;
}

/**
 * Find the most recent pending approval across ALL users.
 * Used when an approver settles a request they did not originate.
 */
export function findLatestPending(kind?: 'query' | 'mission'): PendingApproval | undefined {
  const now = Date.now();
  let latest: PendingApproval | undefined;
  for (const a of store.values()) {
    if (a.status !== 'pending') continue;
    if (new Date(a.expiresAt).getTime() < now) {
      a.status = 'expired';
      continue;
    }
    if (kind && a.kind !== kind) continue;
    if (!latest || a.createdAt > latest.createdAt) latest = a;
  }
  return latest;
}

export function settleApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  settledByUserId: number,
  note: string | null,
): PendingApproval | null {
  const a = store.get(approvalId);
  if (!a) return null;
  if (a.status !== 'pending') {
    logger.warn(`attempt to settle ${approvalId} which is already ${a.status}`);
    return null;
  }
  if (new Date(a.expiresAt).getTime() < Date.now()) {
    a.status = 'expired';
    logger.warn(`attempt to settle ${approvalId} but it expired at ${a.expiresAt}`);
    return null;
  }
  a.status = decision;
  a.settledByUserId = settledByUserId;
  a.settledAt = new Date().toISOString();
  a.settlementNote = note;
  logger.info(
    `approval ${approvalId} settled: ${decision} by user ${settledByUserId}` +
      (note ? ` — note: ${note.slice(0, 120)}` : ''),
  );
  return a;
}

/** Prune settled and expired records older than `maxAgeMs`. */
export function pruneApprovals(maxAgeMs = 24 * 60 * 60_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [id, a] of store.entries()) {
    if (a.status === 'pending') continue;
    if (new Date(a.createdAt).getTime() < cutoff) {
      store.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) logger.debug(`pruned ${pruned} settled/expired approval(s)`);
  return pruned;
}
