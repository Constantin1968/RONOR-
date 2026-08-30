/**
 * RONOR — L2 · Persistence · Memory Manager
 * ──────────────────────────────────────────
 * The single interface through which the runtime reads and writes durable
 * memory. It composes the Supabase adapter (relational), the R2 adapter
 * (object store) and the Qdrant knowledge plane (vector search) into one
 * coherent surface.
 *
 * The manager is the place where degradation is reported and isolated. A
 * caller that asks for recent memory entries should not need to know whether
 * Supabase is up; it should get what is available and a degradation flag that
 * says what is missing. The alternative — propagating exceptions from three
 * different stores through every caller — produces code that handles
 * infrastructure failures in the business logic layer, which is the wrong place.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../utils/logger';
import { getSupabaseAdapter, type MemoryEntryRow, type AuditEventRow, type MissionRow } from './supabase-adapter';
import { getR2Adapter, type EvidenceObject } from './r2-adapter';

const logger = createLogger('RONOR:Persistence:MemoryManager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryWriteResult {
  ok: boolean;
  id: string | null;
  degraded: boolean;
  degradationReason: string | null;
}

export interface MemoryReadResult<T> {
  ok: boolean;
  data: T;
  degraded: boolean;
  degradationReason: string | null;
}

export interface EvidenceWriteResult {
  ok: boolean;
  object: EvidenceObject | null;
  degraded: boolean;
  degradationReason: string | null;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private readonly supabase = getSupabaseAdapter();
  private readonly r2 = getR2Adapter();

  get supabaseAvailable(): boolean {
    return this.supabase?.isAvailable ?? false;
  }

  get r2Available(): boolean {
    return this.r2?.isAvailable ?? false;
  }

  // ---- Memory entries ------------------------------------------------------

  async remember(entry: Omit<MemoryEntryRow, 'id' | 'created_at'>): Promise<MemoryWriteResult> {
    if (!this.supabase) {
      return { ok: false, id: null, degraded: true, degradationReason: 'Supabase not configured' };
    }
    try {
      const id = await this.supabase.insertMemoryEntry(entry as MemoryEntryRow);
      return { ok: true, id, degraded: false, degradationReason: null };
    } catch (err) {
      logger.error('remember() failed:', err);
      return { ok: false, id: null, degraded: true, degradationReason: String(err) };
    }
  }

  async recall(params: {
    userId?: string;
    sessionId?: string;
    kind?: MemoryEntryRow['kind'];
    limit?: number;
  }): Promise<MemoryReadResult<MemoryEntryRow[]>> {
    if (!this.supabase) {
      return { ok: false, data: [], degraded: true, degradationReason: 'Supabase not configured' };
    }
    try {
      const data = await this.supabase.queryMemoryEntries(params);
      return { ok: true, data, degraded: !this.supabase.isAvailable, degradationReason: null };
    } catch (err) {
      logger.error('recall() failed:', err);
      return { ok: false, data: [], degraded: true, degradationReason: String(err) };
    }
  }

  // ---- Missions ------------------------------------------------------------

  async persistMission(mission: MissionRow): Promise<MemoryWriteResult> {
    if (!this.supabase) {
      return { ok: false, id: null, degraded: true, degradationReason: 'Supabase not configured' };
    }
    try {
      await this.supabase.upsertMission(mission);
      return { ok: true, id: mission.mission_id, degraded: false, degradationReason: null };
    } catch (err) {
      logger.error('persistMission() failed:', err);
      return { ok: false, id: null, degraded: true, degradationReason: String(err) };
    }
  }

  async getMission(missionId: string): Promise<MemoryReadResult<MissionRow | null>> {
    if (!this.supabase) {
      return { ok: false, data: null, degraded: true, degradationReason: 'Supabase not configured' };
    }
    try {
      const data = await this.supabase.getMission(missionId);
      return { ok: true, data, degraded: false, degradationReason: null };
    } catch (err) {
      return { ok: false, data: null, degraded: true, degradationReason: String(err) };
    }
  }

  // ---- Audit events --------------------------------------------------------

  /**
   * Record one audit event. Still fire-and-forget for the CALLER — it never
   * throws — but it now REPORTS the outcome instead of hiding it: true only when
   * the register confirmed the write, false when the write was rejected, when
   * the register was unreachable, or when persistence is not configured.
   *
   * The audit mirror needs this answer. Inferring success from a reachability
   * flag counts a rejected row as mirrored, which turns a register with holes
   * into a register that looks complete.
   */
  async recordAuditEvent(event: Omit<AuditEventRow, 'id' | 'occurred_at'>): Promise<boolean> {
    if (!this.supabase) {
      logger.debug('audit event not persisted — Supabase not configured');
      return false;
    }
    try {
      return await this.supabase.insertAuditEvent(event as AuditEventRow);
    } catch (err) {
      // Audit events are fire-and-forget. A failure to persist an event must not
      // prevent the runtime from answering the query it is recording.
      logger.error('recordAuditEvent() failed (non-fatal):', err);
      return false;
    }
  }

  // ---- Evidence storage ----------------------------------------------------

  async storeEvidence(params: {
    content: Buffer | string;
    contentType: string;
    prefix?: string;
    metadata?: Record<string, string>;
  }): Promise<EvidenceWriteResult> {
    if (!this.r2) {
      return { ok: false, object: null, degraded: true, degradationReason: 'R2 not configured' };
    }
    const content = typeof params.content === 'string' ? Buffer.from(params.content, 'utf8') : params.content;
    try {
      const object = await this.r2.putEvidence({ ...params, content });
      if (!object) {
        return { ok: false, object: null, degraded: true, degradationReason: 'R2 write returned null' };
      }
      return { ok: true, object, degraded: false, degradationReason: null };
    } catch (err) {
      logger.error('storeEvidence() failed:', err);
      return { ok: false, object: null, degraded: true, degradationReason: String(err) };
    }
  }

  async storeJsonEvidence(data: unknown, prefix?: string, metadata?: Record<string, string>): Promise<EvidenceWriteResult> {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    return this.storeEvidence({ content, contentType: 'application/json', prefix, metadata });
  }

  async retrieveEvidence(key: string): Promise<Buffer | null> {
    if (!this.r2) return null;
    return this.r2.getEvidence(key);
  }

  // ---- Health --------------------------------------------------------------

  async healthCheck(): Promise<{
    supabase: boolean;
    r2: boolean;
    degraded: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];
    let supabaseOk = false;
    let r2Ok = false;

    if (this.supabase) {
      supabaseOk = await this.supabase.ping();
      if (!supabaseOk) reasons.push('Supabase unreachable');
    } else {
      reasons.push('Supabase not configured');
    }

    if (this.r2) {
      // R2 does not have a dedicated health endpoint; availability is inferred
      // from the last operation result.
      r2Ok = this.r2.isAvailable;
      if (!r2Ok) reasons.push('R2 last operation failed');
    } else {
      reasons.push('R2 not configured');
    }

    return {
      supabase: supabaseOk,
      r2: r2Ok,
      degraded: !supabaseOk || !r2Ok,
      reasons,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!_manager) _manager = new MemoryManager();
  return _manager;
}
