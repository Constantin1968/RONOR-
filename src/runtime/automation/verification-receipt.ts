import crypto from 'node:crypto';
import type { VerificationEvidence, VerificationReceipt } from './contracts';

const RECEIPT_VERSION = 'ronor-codex-receipt/v1' as const;

export function verificationEvidenceDigest(evidence: VerificationEvidence): string {
  return crypto.createHash('sha256').update(JSON.stringify({ claims: evidence.claims, artifacts: evidence.artifacts })).digest('hex');
}

function receiptPayload(receipt: Omit<VerificationReceipt, 'signature'>): string {
  return JSON.stringify([
    receipt.version, receipt.issuer, receipt.mission_id, receipt.verdict,
    receipt.evidence_digest, receipt.issued_at,
  ]);
}

export function signVerificationReceipt(params: {
  privateKeyPem: string; missionId: string; verdict: 'pass' | 'fail'; evidence: VerificationEvidence; now?: Date;
}): VerificationReceipt {
  const key = crypto.createPrivateKey(params.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('verification_receipt_private_key_invalid');
  const unsigned: Omit<VerificationReceipt, 'signature'> = {
    version: RECEIPT_VERSION, issuer: 'codex-verifier', mission_id: params.missionId,
    verdict: params.verdict, evidence_digest: verificationEvidenceDigest(params.evidence),
    issued_at: (params.now ?? new Date()).toISOString(),
  };
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(receiptPayload(unsigned)), key).toString('base64url') };
}

export function verifyVerificationReceipt(params: {
  publicKeyPem: string; receipt: VerificationReceipt; missionId: string; verdict: 'pass' | 'fail'; evidence: VerificationEvidence;
  now?: Date; maxAgeMs?: number;
}): boolean {
  const receipt = params.receipt;
  if (receipt.version !== RECEIPT_VERSION || receipt.issuer !== 'codex-verifier' ||
      receipt.mission_id !== params.missionId || receipt.verdict !== params.verdict ||
      receipt.evidence_digest !== verificationEvidenceDigest(params.evidence) ||
      !/^[A-Za-z0-9_-]{80,120}$/.test(receipt.signature)) return false;
  const issued = Date.parse(receipt.issued_at); const now = (params.now ?? new Date()).getTime();
  if (!Number.isFinite(issued) || issued > now + 30_000 || now - issued > (params.maxAgeMs ?? 300_000)) return false;
  const unsigned = { ...receipt }; delete (unsigned as Partial<VerificationReceipt>).signature;
  try {
    const key = crypto.createPublicKey(params.publicKeyPem);
    return key.asymmetricKeyType === 'ed25519' && crypto.verify(
      null, Buffer.from(receiptPayload(unsigned as Omit<VerificationReceipt, 'signature'>)), key,
      Buffer.from(receipt.signature, 'base64url'),
    );
  } catch { return false; }
}
