import crypto from 'node:crypto';
import type { ExecutionMandate } from './contracts';
import { ALWAYS_DENIED_ACTIONS, DEFAULT_ALLOWED_ACTIONS, objectiveHash } from './policy';

export interface MandateRequest {
  missionId: string;
  objective: string;
  workspaceRoot: string;
  branch: string;
  architectKeyId: string;
  idempotencyKey?: string;
  maxCostUsd?: number;
  maxRuntimeMinutes?: number;
  maxFixCycles?: number;
  now?: Date;
}

export interface MandateCeilings {
  maxCostUsd: number;
  maxRuntimeMinutes: number;
  maxFixCycles: number;
}

function bounded(value: number | undefined, ceiling: number, minimum: number): number {
  const selected = value ?? ceiling;
  if (!Number.isFinite(selected) || selected < minimum || selected > ceiling) throw new Error('mandate_limit_outside_policy');
  return selected;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signingKey(value: string): Buffer {
  const key = Buffer.from(value, 'utf8');
  if (key.length < 32) throw new Error('mandate_signing_key_invalid');
  return key;
}

function authorityPayload(mandate: ExecutionMandate): string {
  const { authority_signature: _signature, ...signed } = mandate;
  return stableJson(signed);
}

export function verifyMandateAuthority(mandate: ExecutionMandate, secret: string): boolean {
  if (mandate.authority_version !== 'ronor-mandate/v1' ||
      typeof mandate.authority_signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(mandate.authority_signature)) return false;
  try {
    const expected = crypto.createHmac('sha256', signingKey(secret)).update(authorityPayload(mandate)).digest();
    const actual = Buffer.from(mandate.authority_signature, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function signMandateAuthority(mandate: ExecutionMandate, secret: string): ExecutionMandate {
  const signed: ExecutionMandate = { ...mandate, authority_version: 'ronor-mandate/v1' };
  delete signed.authority_signature;
  signed.authority_signature = crypto.createHmac('sha256', signingKey(secret))
    .update(authorityPayload(signed)).digest('base64url');
  return signed;
}

/** Create authority inside the runtime boundary; the HTTP caller cannot set authority fields. */
export function issueArchitectMandate(request: MandateRequest, ceilings: MandateCeilings, secret: string): ExecutionMandate {
  if (!/^key_[a-f0-9]{12}$/.test(request.architectKeyId)) throw new Error('architect_identity_invalid');
  if (!request.missionId || !request.objective.trim() || !request.workspaceRoot || !request.branch) throw new Error('mandate_subject_invalid');
  if (request.branch === 'main' || request.branch === 'master') throw new Error('protected_branch_refused');
  const now = request.now ?? new Date();
  const runtime = bounded(request.maxRuntimeMinutes, ceilings.maxRuntimeMinutes, 1);
  const mandateId = request.idempotencyKey
    ? `mandate_${crypto.createHash('sha256').update(`${request.architectKeyId}\0${request.missionId}\0${request.idempotencyKey}`).digest('hex').slice(0, 32)}`
    : `mandate_${crypto.randomBytes(16).toString('hex')}`;
  const mandate: ExecutionMandate = {
    authority_version: 'ronor-mandate/v1',
    mandate_id: mandateId,
    mission_id: request.missionId,
    issued_by: 'merlin',
    issued_by_key_id: request.architectKeyId,
    objective_hash: objectiveHash(request.objective),
    workspace_root: request.workspaceRoot,
    branch_prefix: request.branch,
    allowed_actions: [...DEFAULT_ALLOWED_ACTIONS],
    denied_actions: [...ALWAYS_DENIED_ACTIONS],
    max_cost_usd: bounded(request.maxCostUsd, ceilings.maxCostUsd, 0),
    max_runtime_minutes: runtime,
    max_fix_cycles: bounded(request.maxFixCycles, ceilings.maxFixCycles, 0),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + runtime * 60_000).toISOString(),
  };
  return signMandateAuthority(mandate, secret);
}
