import crypto from 'crypto';
import type { Provenance } from './middleware';
import type { QueryRequest } from './pipeline';
import type { MissionDispatchRequest } from '../agents/coordinator';

export type PendingExecution =
  | { kind: 'query'; request: QueryRequest }
  | { kind: 'mission'; request: MissionDispatchRequest };

interface PendingRecord {
  id: string;
  execution: PendingExecution;
  provenance: Provenance;
  env: NodeJS.ProcessEnv;
  apiKeyId: string;
  decisionId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

const pending = new Map<string, PendingRecord>();

function ttlMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.RONOR_APPROVAL_TTL_MINUTES ?? 15);
  const minutes = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.trunc(raw))) : 15;
  return minutes * 60_000;
}

export function createPendingExecution(params: {
  execution: PendingExecution;
  provenance: Provenance;
  env: NodeJS.ProcessEnv;
  apiKeyId: string;
}): { approvalId: string; expiresAt: string } {
  const now = Date.now();
  const id = `rapv_${crypto.randomBytes(24).toString('base64url')}`;
  const record: PendingRecord = {
    id,
    execution: params.execution,
    provenance: { ...params.provenance },
    env: params.env,
    apiKeyId: params.apiKeyId,
    decisionId: params.provenance.request_id,
    createdAtMs: now,
    expiresAtMs: now + ttlMs(params.env),
  };
  pending.set(id, record);
  return { approvalId: id, expiresAt: new Date(record.expiresAtMs).toISOString() };
}

export type ConsumePendingResult =
  | { status: 'ready'; record: PendingRecord }
  | { status: 'not-found' | 'expired' | 'key-mismatch' };

export function consumePendingExecution(
  approvalId: string,
  apiKeyId: string,
): ConsumePendingResult {
  const record = pending.get(approvalId);
  if (!record) return { status: 'not-found' };
  if (record.expiresAtMs < Date.now()) {
    pending.delete(approvalId);
    return { status: 'expired' };
  }
  if (record.apiKeyId !== apiKeyId) return { status: 'key-mismatch' };
  // Delete before execution: a concurrent or retried settlement can never run twice.
  pending.delete(approvalId);
  return { status: 'ready', record };
}

export function rejectPendingExecution(approvalId: string, apiKeyId: string): ConsumePendingResult {
  return consumePendingExecution(approvalId, apiKeyId);
}

export function resetPendingExecutions(): void {
  pending.clear();
}
