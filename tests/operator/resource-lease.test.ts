/**
 * G1.4 — lease pe resursă: două execuții nu primesc același arbore/echipament.
 * Noul `ResourceLeaseManager` impune exclusivitate pe resursă canonică,
 * spre deosebire de `run-lease.ts` care lease-uiește `run_id`/`mandate_id` (F09).
 */
import { ResourceLeaseManager } from '../../src/runtime/operator/resource-lease';

const T0 = new Date('2026-09-16T10:00:00Z');

describe('operator resource lease (G1.4)', () => {
  it('o singură deținere odată pe aceeași resursă', () => {
    const leases = new ResourceLeaseManager();
    expect(
      leases.claim({ resource: '/work/proba-001', owner: 'misiune-a', leaseMs: 60_000, now: T0 }),
    ).toEqual({ outcome: 'acquired' });
    expect(
      leases.claim({ resource: '/work/proba-001', owner: 'misiune-b', leaseMs: 60_000, now: T0 }).outcome,
    ).toBe('busy');
  });

  it('eliberarea de către deținător redeschide resursa; non-deținătorul nu poate elibera', () => {
    const leases = new ResourceLeaseManager();
    leases.claim({ resource: '/work/proba-001', owner: 'misiune-a', leaseMs: 60_000, now: T0 });
    expect(leases.release({ resource: '/work/proba-001', owner: 'misiune-b' })).toBe(false);
    expect(leases.release({ resource: '/work/proba-001', owner: 'misiune-a' })).toBe(true);
    expect(
      leases.claim({ resource: '/work/proba-001', owner: 'misiune-b', leaseMs: 60_000, now: T0 }),
    ).toEqual({ outcome: 'acquired' });
  });

  it('lease-ul expirat poate fi preluat; resursele distincte sunt independente', () => {
    const leases = new ResourceLeaseManager();
    leases.claim({ resource: '/work/proba-001', owner: 'misiune-a', leaseMs: 1_000, now: T0 });
    const later = new Date(T0.getTime() + 61_000);
    expect(
      leases.claim({ resource: '/work/proba-001', owner: 'misiune-b', leaseMs: 60_000, now: later }),
    ).toEqual({ outcome: 'acquired' });
    expect(
      leases.claim({ resource: '/work/proba-002', owner: 'misiune-c', leaseMs: 60_000, now: later }),
    ).toEqual({ outcome: 'acquired' });
  });
});
