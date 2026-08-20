import crypto from 'crypto';

export interface ExecutionCapabilityClaims {
  audience: 'openhands-bridge';
  mandate_id: string;
  mission_id: string;
  assignment_id: string;
  objective_hash: string;
  allowed_actions: string[];
  expires_at: string;
  nonce: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signExecutionCapability(claims: ExecutionCapabilityClaims, key: string): string {
  if (Buffer.byteLength(key, 'utf8') < 32) throw new Error('capability_key_too_short');
  const payload = encode(claims);
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyExecutionCapability(token: string, key: string, now = new Date()): ExecutionCapabilityClaims | null {
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra || Buffer.byteLength(key, 'utf8') < 32) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ExecutionCapabilityClaims;
    if (claims.audience !== 'openhands-bridge' || !claims.nonce || Date.parse(claims.expires_at) <= now.getTime()) return null;
    return claims;
  } catch { return null; }
}
