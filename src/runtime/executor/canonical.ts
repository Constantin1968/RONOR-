/**
 * Serializare canonică și semnături HMAC pentru executorul cu mandat.
 *
 * Aceeași valoare logică dă întotdeauna aceiași octeți: cheile obiectelor sunt
 * sortate, iar valorile care nu au reprezentare JSON stabilă (`undefined`,
 * funcții, numere nefinite) sunt refuzate, nu omise în tăcere. Un hash de
 * acțiune calculat din alt text decât cel semnat nu poate coincide.
 */
import crypto from 'node:crypto';

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error('canonical_depth_exceeded');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical_non_finite_number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical_unsupported_type:${typeof value}`);
  }
}

export function sha256Hex(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function secretKey(secret: string, label: string): Buffer {
  const key = Buffer.from(secret, 'utf8');
  if (key.length < 32) throw new Error(`${label}_key_invalid`);
  return key;
}

export function hmacBase64Url(secret: string, label: string, payload: string): string {
  return crypto.createHmac('sha256', secretKey(secret, label)).update(payload).digest('base64url');
}

export function hmacEquals(secret: string, label: string, payload: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  try {
    const expected = crypto.createHmac('sha256', secretKey(secret, label)).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
