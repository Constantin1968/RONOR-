/**
 * Semnături asimetrice Ed25519 pentru executorul cu mandat (D3).
 *
 * Înainte, mandatul, aprobarea și chitanța erau HMAC: executorul trebuia să
 * dețină aceeași cheie cu care se semnează, deci un proces care rula ca
 * `ronor-exec` își putea emite singur mandate și aprobări. Acum:
 *   - emitentul mandatului și omul care aprobă dețin cheile private, în afara
 *     executorului; executorul primește numai cheile lor publice (un „inel”);
 *   - executorul are o singură cheie privată, a lui, cu care semnează numai
 *     chitanțe; cheia publică a chitanțelor e publică;
 *   - identificatorul unei chei (`key_<12 hex>`) e amprenta cheii publice
 *     (SHA-256 peste SPKI DER), deci nu poate fi ales de semnatar.
 *
 * Fiecare semnătură are o etichetă de domeniu (`ronor-…/v2`): o semnătură de
 * chitanță nu poate trece drept aprobare, chiar dacă ar fi aceeași cheie.
 */
import crypto from 'node:crypto';
import { sha256Hex } from './canonical';

export type SignatureDomain = 'ronor-ops-mandate/v2' | 'ronor-actuation-approval/v2' | 'ronor-execution-receipt/v2';

/** Cheile publice acceptate pentru un rol, indexate după amprentă. */
export type PublicKeyring = ReadonlyMap<string, crypto.KeyObject>;

const PUBLIC_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export function keyId(key: crypto.KeyObject): string {
  const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
  return `key_${sha256Hex(pub.export({ type: 'spki', format: 'der' })).slice(0, 12)}`;
}

function assertEd25519(key: crypto.KeyObject, label: string): crypto.KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${label}_key_not_ed25519`);
  return key;
}

/** Cheia privată a unui semnatar (PEM PKCS#8 Ed25519). */
export function parsePrivateKey(pem: string, label: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error(`${label}_private_key_invalid`);
  }
  return assertEd25519(key, label);
}

/**
 * Un inel de chei publice (unul sau mai multe blocuri PEM SPKI). Un fișier care
 * conține o cheie privată e refuzat: executorul nu trebuie să poată semna în
 * locul emitentului sau al omului care aprobă.
 */
export function parsePublicKeyring(pem: string, label: string): PublicKeyring {
  if (/PRIVATE KEY/.test(pem)) throw new Error(`${label}_keyring_contains_private_key`);
  const blocks = pem.match(PUBLIC_BLOCK) ?? [];
  if (blocks.length === 0 || blocks.length > 16) throw new Error(`${label}_keyring_invalid`);
  const ring = new Map<string, crypto.KeyObject>();
  for (const block of blocks) {
    let key: crypto.KeyObject;
    try {
      key = crypto.createPublicKey(block);
    } catch {
      throw new Error(`${label}_keyring_invalid`);
    }
    assertEd25519(key, label);
    ring.set(keyId(key), key);
  }
  return ring;
}

export function keyringFrom(keys: crypto.KeyObject[]): PublicKeyring {
  const ring = new Map<string, crypto.KeyObject>();
  for (const key of keys) {
    const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
    ring.set(keyId(assertEd25519(pub, 'keyring')), pub);
  }
  return ring;
}

export function signDomain(domain: SignatureDomain, payload: string, privateKey: crypto.KeyObject): string {
  if (privateKey.type !== 'private') throw new Error(`${domain}:signing_requires_private_key`);
  return crypto.sign(null, Buffer.from(`${domain}\n${payload}`, 'utf8'), privateKey).toString('base64url');
}

export function verifyDomain(domain: SignatureDomain, payload: string, signature: unknown, publicKey: crypto.KeyObject): boolean {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
  try {
    return crypto.verify(null, Buffer.from(`${domain}\n${payload}`, 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Generează o pereche Ed25519, în PEM; cheia privată nu se afișează nicăieri de cod. */
export function generateSigningKeyPair(): { privatePem: string; publicPem: string; keyId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyId(publicKey),
  };
}
