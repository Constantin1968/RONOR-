/**
 * Aprobarea umană pentru `ops.actuate`, legată de acțiunea exactă.
 *
 * Înainte, aprobarea era un boolean (`approved: true`), nelegat de nimic: o
 * aprobare dată pentru „repornește runtime-ul” putea acoperi orice altă
 * actuare. Acum aprobarea este un obiect semnat (HMAC-SHA256, cheie separată
 * de cea a mandatelor) care conține:
 *   - `action_hash`: SHA-256 peste forma canonică a acțiunii (mandat, tip,
 *     argumente tipizate, resursă, gazdă). O schimbare de un octet dă alt hash;
 *   - `mandate_id`: aprobarea nu trece la alt mandat;
 *   - `issued_at` / `expires_at`: fereastră de cel mult `MAX_APPROVAL_TTL_MS`;
 *   - `approval_id`: nonce de unică folosință (executorul îl consumă în jurnal).
 */
import crypto from 'node:crypto';
import { canonicalJson, hmacBase64Url, hmacEquals, sha256Hex } from './canonical';

export const APPROVAL_VERSION = 'ronor-actuation-approval/v1' as const;
/** Cel mult 15 minute între emiterea aprobării și expirarea ei. */
export const MAX_APPROVAL_TTL_MS = 15 * 60_000;

export interface ActionIdentity {
  host_id: string;
  mandate_id: string;
  type: string;
  args: Record<string, unknown>;
  resource: string;
}

export interface ActuationApproval {
  version: typeof APPROVAL_VERSION;
  approval_id: string;
  mandate_id: string;
  action_hash: string;
  approver_key_id: string;
  channel: 'console' | 'telegram';
  issued_at: string;
  expires_at: string;
  signature: string;
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

/** Hash-ul acțiunii exacte: aceeași intrare dă același hash, orice altă intrare alt hash. */
export function actionHash(identity: ActionIdentity): string {
  return sha256Hex(
    canonicalJson({
      v: 'ronor-action/v1',
      host_id: identity.host_id,
      mandate_id: identity.mandate_id,
      type: identity.type,
      args: identity.args,
      resource: identity.resource,
    }),
  );
}

function payload(approval: Omit<ActuationApproval, 'signature'>): string {
  return canonicalJson({
    version: approval.version,
    approval_id: approval.approval_id,
    mandate_id: approval.mandate_id,
    action_hash: approval.action_hash,
    approver_key_id: approval.approver_key_id,
    channel: approval.channel,
    issued_at: approval.issued_at,
    expires_at: approval.expires_at,
  });
}

export function signActuationApproval(
  fields: {
    mandateId: string;
    actionHash: string;
    approverKeyId: string;
    channel?: ActuationApproval['channel'];
    ttlMs: number;
    now?: Date;
    approvalId?: string;
  },
  secret: string,
): ActuationApproval {
  if (!/^[a-f0-9]{64}$/.test(fields.actionHash)) throw new Error('approval_action_hash_invalid');
  if (!/^key_[a-f0-9]{12}$/.test(fields.approverKeyId)) throw new Error('approval_approver_invalid');
  if (!Number.isFinite(fields.ttlMs) || fields.ttlMs < 1_000 || fields.ttlMs > MAX_APPROVAL_TTL_MS)
    throw new Error('approval_ttl_outside_policy');
  const now = fields.now ?? new Date();
  const unsigned: Omit<ActuationApproval, 'signature'> = {
    version: APPROVAL_VERSION,
    approval_id: fields.approvalId ?? `appr_${crypto.randomBytes(16).toString('hex')}`,
    mandate_id: fields.mandateId,
    action_hash: fields.actionHash,
    approver_key_id: fields.approverKeyId,
    channel: fields.channel ?? 'console',
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + fields.ttlMs).toISOString(),
  };
  return { ...unsigned, signature: hmacBase64Url(secret, 'approval', payload(unsigned)) };
}

function isApprovalShape(value: unknown): value is ActuationApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const keys = Object.keys(a).sort().join(',');
  if (keys !== 'action_hash,approval_id,approver_key_id,channel,expires_at,issued_at,mandate_id,signature,version') return false;
  return (
    a.version === APPROVAL_VERSION &&
    typeof a.approval_id === 'string' && /^appr_[a-f0-9]{32}$/.test(a.approval_id) &&
    typeof a.mandate_id === 'string' && a.mandate_id.length > 0 && a.mandate_id.length <= 120 &&
    typeof a.action_hash === 'string' && /^[a-f0-9]{64}$/.test(a.action_hash) &&
    typeof a.approver_key_id === 'string' && /^key_[a-f0-9]{12}$/.test(a.approver_key_id) &&
    (a.channel === 'console' || a.channel === 'telegram') &&
    typeof a.issued_at === 'string' && typeof a.expires_at === 'string' &&
    typeof a.signature === 'string'
  );
}

/**
 * Verifică aprobarea pentru acțiunea exactă. Ordinea contează: forma, apoi
 * semnătura, apoi legăturile (mandat, hash), apoi fereastra de timp.
 */
export function verifyActuationApproval(
  approval: unknown,
  expected: { mandateId: string; actionHash: string; now: Date },
  secret: string,
): ApprovalCheck {
  if (!isApprovalShape(approval)) return { ok: false, reason: 'approval_malformed' };
  const { signature, ...unsigned } = approval;
  if (!hmacEquals(secret, 'approval', payload(unsigned), signature)) return { ok: false, reason: 'approval_signature_invalid' };
  if (approval.mandate_id !== expected.mandateId) return { ok: false, reason: 'approval_mandate_mismatch' };
  if (approval.action_hash !== expected.actionHash) return { ok: false, reason: 'approval_action_mismatch' };
  const issued = Date.parse(approval.issued_at);
  const expires = Date.parse(approval.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return { ok: false, reason: 'approval_malformed' };
  if (expires - issued > MAX_APPROVAL_TTL_MS) return { ok: false, reason: 'approval_ttl_exceeds_policy' };
  const now = expected.now.getTime();
  if (now < issued) return { ok: false, reason: 'approval_not_yet_valid' };
  if (now >= expires) return { ok: false, reason: 'approval_expired' };
  return { ok: true };
}
