/**
 * Aprobarea umană pentru `ops.actuate`, legată de acțiunea exactă.
 *
 * Aprobarea este un obiect semnat Ed25519 de omul care aprobă (D3): executorul
 * are numai cheile publice ale aprobatorilor, deci nu poate produce o aprobare
 * validă. Conținutul semnat:
 *   - `action_hash`: SHA-256 peste forma canonică a acțiunii (mandat, tip,
 *     argumente tipizate, resursă, gazdă). O schimbare de un octet dă alt hash;
 *   - `mandate_id`: aprobarea nu trece la alt mandat;
 *   - `origin`: proveniența cererii, declarată de om la aprobare (D4). Cererea
 *     nu o mai poate declara; o schimbare a ei invalidează semnătura;
 *   - `issued_at` / `expires_at`: fereastră de cel mult `MAX_APPROVAL_TTL_MS`;
 *   - `approval_id`: nonce de unică folosință (executorul îl consumă în jurnal);
 *   - `approver_key_id`: amprenta cheii publice cu care se verifică.
 */
import crypto from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical';
import { keyId, signDomain, verifyDomain, type PublicKeyring } from './keys';

export const APPROVAL_VERSION = 'ronor-actuation-approval/v2' as const;
/** Cel mult 15 minute între emiterea aprobării și expirarea ei. */
export const MAX_APPROVAL_TTL_MS = 15 * 60_000;

export type RequestOrigin = 'operator' | 'memory' | 'model' | 'external';
export const REQUEST_ORIGINS: readonly RequestOrigin[] = ['operator', 'memory', 'model', 'external'];

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
  origin: RequestOrigin;
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
    origin: approval.origin,
    issued_at: approval.issued_at,
    expires_at: approval.expires_at,
  });
}

/** Semnează o aprobare; cere cheia privată a omului care aprobă. */
export function signActuationApproval(
  fields: {
    mandateId: string;
    actionHash: string;
    channel?: ActuationApproval['channel'];
    origin?: RequestOrigin;
    ttlMs: number;
    now?: Date;
    approvalId?: string;
  },
  approverPrivateKey: crypto.KeyObject,
): ActuationApproval {
  if (!/^[a-f0-9]{64}$/.test(fields.actionHash)) throw new Error('approval_action_hash_invalid');
  if (!Number.isFinite(fields.ttlMs) || fields.ttlMs < 1_000 || fields.ttlMs > MAX_APPROVAL_TTL_MS)
    throw new Error('approval_ttl_outside_policy');
  const origin = fields.origin ?? 'operator';
  if (!REQUEST_ORIGINS.includes(origin)) throw new Error('approval_origin_invalid');
  if (approverPrivateKey.type !== 'private') throw new Error('approval_signing_requires_private_key');
  const now = fields.now ?? new Date();
  const unsigned: Omit<ActuationApproval, 'signature'> = {
    version: APPROVAL_VERSION,
    approval_id: fields.approvalId ?? `appr_${crypto.randomBytes(16).toString('hex')}`,
    mandate_id: fields.mandateId,
    action_hash: fields.actionHash,
    approver_key_id: keyId(approverPrivateKey),
    channel: fields.channel ?? 'console',
    origin,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + fields.ttlMs).toISOString(),
  };
  return { ...unsigned, signature: signDomain(APPROVAL_VERSION, payload(unsigned), approverPrivateKey) };
}

function isApprovalShape(value: unknown): value is ActuationApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const keys = Object.keys(a).sort().join(',');
  if (keys !== 'action_hash,approval_id,approver_key_id,channel,expires_at,issued_at,mandate_id,origin,signature,version') return false;
  return (
    a.version === APPROVAL_VERSION &&
    typeof a.approval_id === 'string' && /^appr_[a-f0-9]{32}$/.test(a.approval_id) &&
    typeof a.mandate_id === 'string' && a.mandate_id.length > 0 && a.mandate_id.length <= 120 &&
    typeof a.action_hash === 'string' && /^[a-f0-9]{64}$/.test(a.action_hash) &&
    typeof a.approver_key_id === 'string' && /^key_[a-f0-9]{12}$/.test(a.approver_key_id) &&
    (a.channel === 'console' || a.channel === 'telegram') &&
    typeof a.origin === 'string' && (REQUEST_ORIGINS as readonly string[]).includes(a.origin) &&
    typeof a.issued_at === 'string' && typeof a.expires_at === 'string' &&
    typeof a.signature === 'string'
  );
}

/**
 * Verifică aprobarea pentru acțiunea exactă. Ordinea contează: forma, cheia
 * aprobatorului, semnătura, proveniența, apoi legăturile (mandat, hash), apoi
 * fereastra de timp. Proveniența se citește numai din conținutul semnat.
 */
export function verifyActuationApproval(
  approval: unknown,
  expected: { mandateId: string; actionHash: string; now: Date },
  approverKeys: PublicKeyring,
): ApprovalCheck {
  if (!isApprovalShape(approval)) return { ok: false, reason: 'approval_malformed' };
  const { signature, ...unsigned } = approval;
  const key = approverKeys.get(approval.approver_key_id);
  if (!key) return { ok: false, reason: 'approval_approver_unknown' };
  if (!verifyDomain(APPROVAL_VERSION, payload(unsigned), signature, key)) return { ok: false, reason: 'approval_signature_invalid' };
  if (approval.origin !== 'operator') return { ok: false, reason: `origin_not_authoritative:${approval.origin}` };
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
