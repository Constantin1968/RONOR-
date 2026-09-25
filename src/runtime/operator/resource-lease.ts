/**
 * RONOR Operator — lease pe resursă (schelet Tranșa 1, fix F09)
 * ─────────────────────────────────────────────────────────────
 * `run-lease.ts` protejează `run_id`/`mandate_id`, nu calea canonică a
 * arborelui sau echipamentul. Rezultat: două mandate distincte pe același
 * workspace primesc simultan `acquired`.
 *
 * Acest manager protejează RESURSA (cale canonică / device id): o singură
 * deținere odată, eliberare explicită, expirare la deadline. Implementare
 * în memorie, deterministă, fără I/O — varianta persistentă (SQLite,
 * tranzacțional) o va înlocui fără să schimbe interfața.
 */

export type ResourceClaimOutcome =
  | { outcome: 'acquired' }
  | { outcome: 'busy'; holder: string };

export interface ResourceLeaseState {
  resource: string;
  owner: string;
  expiresAtMs: number;
}

export function canonicalResource(resource: string): string {
  const trimmed = resource.trim();
  if (!trimmed) throw new Error('operator_resource_invalid');
  // Normalizează separatoarele și slash-urile finale; păstrează case-ul
  // (case-insensitive FS-urile sunt tratate de stratul persistent).
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

export class ResourceLeaseManager {
  private held = new Map<string, ResourceLeaseState>();

  claim(params: { resource: string; owner: string; leaseMs: number; now?: Date }): ResourceClaimOutcome {
    const { owner, leaseMs } = params;
    const nowMs = (params.now ?? new Date()).getTime();
    if (!owner || owner.length > 200) throw new Error('operator_lease_owner_invalid');
    if (!Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 3_600_000)
      throw new Error('operator_lease_duration_invalid');
    const resource = canonicalResource(params.resource);
    const current = this.held.get(resource);
    if (current && current.expiresAtMs > nowMs) {
      return { outcome: 'busy', holder: current.owner };
    }
    this.held.set(resource, { resource, owner, expiresAtMs: nowMs + leaseMs });
    return { outcome: 'acquired' };
  }

  release(params: { resource: string; owner: string }): boolean {
    const resource = canonicalResource(params.resource);
    const current = this.held.get(resource);
    if (!current || current.owner !== params.owner) return false;
    this.held.delete(resource);
    return true;
  }

  holder(resource: string, now: Date = new Date()): string | null {
    const key = canonicalResource(resource);
    const current = this.held.get(key);
    if (!current || current.expiresAtMs <= now.getTime()) return null;
    return current.owner;
  }
}
