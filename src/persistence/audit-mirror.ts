/**
 * RONOR — L2 · Persistence · Audit Mirror (oglindirea lanțului de audit)
 * ──────────────────────────────────────────────────────────────────────
 * The local SHA-256 hash chain (`data/audit.db`, table `audit_chain`) is and
 * remains the AUTHORITATIVE register. This module mirrors every link of that
 * chain into the sovereign relational register (`ronor.audit_events`, reached
 * through the governance data layer) so the two can be reconciled by
 * `audit_chain_hash`.
 *
 * Why this module exists: `memory-manager.ts` and `supabase-adapter.ts` were
 * dead code — nothing outside `src/persistence/` called them — so
 * `ronor.audit_events` held zero rows while the local chain held real links.
 * A governance register that is configured, reachable and empty is worse than
 * one that is absent, because it looks like evidence.
 *
 * Non-negotiable properties
 * ─────────────────────────
 *   · MIRRORING NEVER BLOCKS AND NEVER THROWS INTO `append()`. The local chain
 *     is authoritative; a relational outage must not be able to refuse, delay
 *     or corrupt an audit link. Every entry point is wrapped.
 *   · FIRE-AND-FORGET. `programeazaOglindire()` returns synchronously and the
 *     promise is consumed with `.catch()`, never awaited by the caller.
 *   · CONSTRAINED VOCABULARY. `ronor.audit_events.event_type` is guarded by
 *     `audit_events_event_type_check`; any value outside the eleven admitted
 *     ones is rejected by PostgREST (HTTP 400/403) and the row is lost. The
 *     local `decision_type` vocabulary is open, so it MUST be translated, and
 *     the original preserved in `payload_json.decision_type_original` whenever
 *     the translation is lossy.
 *   · NO SECRET IS EVER LOGGED. This module logs counters and error messages,
 *     never configuration values.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../utils/logger';
import { getMemoryManager, type MemoryManager } from './memory-manager';
import { loadSupabaseConfig, getSupabaseAdapter, type AuditEventRow } from './supabase-adapter';
import type { AuditRecord } from '../audit/hash-chain';

const logger = createLogger('RONOR:Persistence:AuditMirror');

// ---------------------------------------------------------------------------
// Vocabularul constrâns
// ---------------------------------------------------------------------------

/**
 * The ONLY values `ronor.audit_events.event_type` accepts. Kept as a frozen
 * literal list rather than inferred, so a drift between code and the database
 * constraint is a visible edit in this file.
 */
export const TIPURI_EVENIMENT_PERMISE = [
  'query',
  'mission_dispatch',
  'cosign_requested',
  'cosign_approved',
  'cosign_rejected',
  'cosign_expired',
  'governance_block',
  'knowledge_ingest',
  'agent_dispatch',
  'system_boot',
  'system_shutdown',
] as const;

export type TipEvenimentPermis = (typeof TIPURI_EVENIMENT_PERMISE)[number];

export function esteTipEvenimentPermis(valoare: string): valoare is TipEvenimentPermis {
  return (TIPURI_EVENIMENT_PERMISE as readonly string[]).includes(valoare);
}

/**
 * Translate the open local `decision_type` vocabulary into the constrained
 * relational one.
 *
 * Precedence is explicit and deliberate: the appeal life-cycle first (it is the
 * most specific), then an explicit governance block or a refusing verdict,
 * then the remaining families, then the default. A refusing verdict outranks
 * the family prefixes because a refused decision is recorded for its refusal,
 * not for the family it would have belonged to had it been allowed.
 *
 * `block` is the local synonym of the relational `deny`.
 */
export function traduTipEveniment(
  decisionType: string | undefined | null,
  verdict?: string | null,
): TipEvenimentPermis {
  const tip = (decisionType ?? '').trim();
  const v = (verdict ?? '').trim().toLowerCase();

  if (tip === 'governance.appeal.opened') return 'cosign_requested';
  if (tip === 'governance.appeal.approved') return 'cosign_approved';
  if (tip === 'governance.appeal.rejected') return 'cosign_rejected';
  if (tip === 'governance.appeal.expired') return 'cosign_expired';

  if (tip.startsWith('governance.block')) return 'governance_block';
  if (v === 'deny' || v === 'block') return 'governance_block';

  if (tip === 'runtime.query' || tip.startsWith('runtime.query.')) return 'query';

  if (tip === 'runtime.agents.dispatch') return 'agent_dispatch';
  if (tip === 'agent' || tip.startsWith('agent.')) return 'agent_dispatch';

  if (tip === 'mission' || tip.startsWith('mission.')) return 'mission_dispatch';
  if (tip === 'knowledge' || tip.startsWith('knowledge.')) return 'knowledge_ingest';

  if (tip === 'system.boot') return 'system_boot';
  if (tip === 'system.shutdown') return 'system_shutdown';

  // Default. The original type is preserved in the payload by
  // `construiesteRandAudit`, so nothing is lost by this fallback.
  return 'query';
}

/**
 * True when the translation lost information and the original type must be
 * carried in the payload.
 */
export function traducereaEsteImplicita(
  decisionType: string | undefined | null,
  verdict?: string | null,
): boolean {
  const tip = (decisionType ?? '').trim();
  if (traduTipEveniment(tip, verdict) !== 'query') return false;
  // A genuine query mapping, or a deny that mapped to governance_block, is not
  // the default branch.
  return !(tip === 'runtime.query' || tip.startsWith('runtime.query.'));
}

/** `escalate` and `deny`/`block` always require a human co-signature. */
export function necesitaCosemnaturaUmana(
  verdict: string | undefined | null,
  cosemnaturaDinPoarta?: boolean,
): boolean {
  const v = (verdict ?? '').trim().toLowerCase();
  if (v === 'escalate' || v === 'deny' || v === 'block') return true;
  return cosemnaturaDinPoarta === true;
}

// ---------------------------------------------------------------------------
// Construcția rândului
// ---------------------------------------------------------------------------

function numarSauNull(valoare: unknown): number | null {
  return typeof valoare === 'number' && Number.isFinite(valoare) ? valoare : null;
}

function textSauNull(valoare: unknown): string | null {
  return typeof valoare === 'string' && valoare.length > 0 ? valoare : null;
}

/**
 * Build the relational row for one link of the local chain.
 *
 * `audit_chain_hash` carries the link's `chain_hash` verbatim. The migration
 * documents that column as "SHA-256 from the runtime SQLite audit chain.
 * Reconciliation key." — it is the only field that makes the two registers
 * comparable, so it is never derived, truncated or recomputed here.
 */
export function construiesteRandAudit(record: AuditRecord): Omit<AuditEventRow, 'id'> {
  const payload = (record.payload ?? {}) as AuditRecord['payload'];
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  const verdict = textSauNull(payload.mi9Result?.verdict);
  const eventType = traduTipEveniment(payload.decisionType, verdict);

  const payloadJson: Record<string, unknown> = {
    ...(payload as unknown as Record<string, unknown>),
    seq: record.seq,
    record_id: record.recordId,
    prev_hash: record.prevHash,
  };
  if (traducereaEsteImplicita(payload.decisionType, verdict)) {
    payloadJson.decision_type_original = payload.decisionType ?? null;
  }

  return {
    event_type: eventType,
    request_id: textSauNull(payload.decisionId),
    mission_id: textSauNull(metadata.mission_id) ?? textSauNull(metadata.missionId),
    user_id: textSauNull(payload.context?.operator?.userId),
    channel: textSauNull(metadata.runtime_surface) ?? textSauNull(metadata.channel),
    verdict,
    human_cosign_required: necesitaCosemnaturaUmana(
      verdict,
      payload.mi9Result?.humanCoSignRequired,
    ),
    cost_usd:
      numarSauNull(metadata.cost_usd) ??
      numarSauNull(metadata.costUsd) ??
      numarSauNull((payload.aiProposal as Record<string, unknown> | undefined)?.costUsd),
    latency_ms: numarSauNull(payload.aiProposal?.latencyMs) ?? numarSauNull(metadata.latency_ms),
    model_id: textSauNull(payload.aiProposal?.model),
    audit_chain_hash: record.chainHash,
    occurred_at: record.timestamp,
    payload_json: payloadJson,
  };
}

// ---------------------------------------------------------------------------
// Contoare și stare
// ---------------------------------------------------------------------------

export interface StareOglindire {
  configurat: boolean;
  accesibil: boolean | null;
  oglindite: number;
  esuate: number;
  ultimul_seq_oglindit: number | null;
  ultimul_seq_local: number | null;
  verigi_neoglindite: number | null;
  ultima_eroare: string | null;
  ultima_reusita_la: string | null;
  degradari: number;
  persistenta_obligatorie: boolean;
}

interface Contoare {
  oglindite: number;
  esuate: number;
  ultimul_seq_oglindit: number | null;
  ultimul_seq_local: number | null;
  ultima_eroare: string | null;
  ultima_reusita_la: string | null;
  degradari: number;
  accesibil: boolean | null;
}

const contoare: Contoare = {
  oglindite: 0,
  esuate: 0,
  ultimul_seq_oglindit: null,
  ultimul_seq_local: null,
  ultima_eroare: null,
  ultima_reusita_la: null,
  degradari: 0,
  accesibil: null,
};

/**
 * The mirror's view of a memory manager.
 *
 * The return type is deliberately `boolean | void`: the real manager CONFIRMS
 * the write, and that confirmation is the primary evidence of success, but an
 * older implementation or a test double that reports nothing must remain usable
 * without silently being counted as a success. `oglindesteVeriga` handles the
 * three cases separately — confirmed, rejected, unreported.
 */
export interface ManagerOglindire {
  recordAuditEvent(
    rand: Parameters<MemoryManager['recordAuditEvent']>[0],
  ): Promise<boolean | void>;
}

let managerInjectat: ManagerOglindire | null = null;
let mediu: NodeJS.ProcessEnv = process.env;

/**
 * Test seam. Production never calls this: the module resolves the singleton
 * manager lazily on first mirror, so importing it opens no socket and reads no
 * credential.
 */
export function configureazaOglindire(options: {
  manager?: ManagerOglindire | null;
  env?: NodeJS.ProcessEnv;
}): void {
  if (options.manager !== undefined) managerInjectat = options.manager;
  if (options.env !== undefined) mediu = options.env;
}

export function reseteazaOglindire(): void {
  contoare.oglindite = 0;
  contoare.esuate = 0;
  contoare.ultimul_seq_oglindit = null;
  contoare.ultimul_seq_local = null;
  contoare.ultima_eroare = null;
  contoare.ultima_reusita_la = null;
  contoare.degradari = 0;
  contoare.accesibil = null;
  managerInjectat = null;
  mediu = process.env;
  memoAccesibil = null;
}

export function persistentaEsteConfigurata(env: NodeJS.ProcessEnv = mediu): boolean {
  if (managerInjectat) return true;
  const url = (env.SUPABASE_URL ?? '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  return url.length > 0 && key.length > 0;
}

export function persistentaEsteObligatorie(env: NodeJS.ProcessEnv = mediu): boolean {
  return env.PERSISTENCE_REQUIRED === 'true';
}

export function stareOglindire(seqLocalMaxim?: number): StareOglindire {
  const configurat = persistentaEsteConfigurata();
  const seqLocal = typeof seqLocalMaxim === 'number' ? seqLocalMaxim : contoare.ultimul_seq_local;
  const neoglindite =
    seqLocal === null
      ? null
      : Math.max(0, seqLocal - (contoare.ultimul_seq_oglindit ?? 0));
  return {
    configurat,
    accesibil: configurat ? contoare.accesibil : false,
    oglindite: contoare.oglindite,
    esuate: contoare.esuate,
    ultimul_seq_oglindit: contoare.ultimul_seq_oglindit,
    ultimul_seq_local: seqLocal,
    verigi_neoglindite: neoglindite,
    ultima_eroare: contoare.ultima_eroare,
    ultima_reusita_la: contoare.ultima_reusita_la,
    degradari: contoare.degradari,
    persistenta_obligatorie: persistentaEsteObligatorie(),
  };
}

// ---------------------------------------------------------------------------
// Oglindirea
// ---------------------------------------------------------------------------

function manager(): ManagerOglindire | null {
  if (managerInjectat) return managerInjectat;
  // Resolved lazily, and only when persistence is configured, so no adapter is
  // constructed and no credential is read in an unconfigured deployment.
  if (!persistentaEsteConfigurata()) return null;
  return getMemoryManager();
}

/**
 * Mirror one link. Resolves; it does not reject. The boolean says whether the
 * relational write was attempted and believed successful.
 */
export async function oglindesteVeriga(record: AuditRecord): Promise<boolean> {
  contoare.ultimul_seq_local = Math.max(contoare.ultimul_seq_local ?? 0, record.seq);

  if (!persistentaEsteConfigurata()) {
    contoare.accesibil = false;
    contoare.ultima_eroare = 'persistență relațională neconfigurată';
    return false;
  }

  try {
    const m = manager();
    if (!m) {
      contoare.accesibil = false;
      contoare.esuate += 1;
      contoare.ultima_eroare = 'manager de memorie indisponibil';
      return false;
    }
    const rand = construiesteRandAudit(record);
    const confirmare = await m.recordAuditEvent(rand);

    // Success is the register's OWN confirmation of the write, never an
    // inference from reachability. A rejection — 400 from the constrained
    // vocabulary, 401 from an expired token, 403 from a missing grant — leaves
    // the register reachable and the row lost, so counting it as mirrored would
    // manufacture the exact false green this module exists to remove.
    if (confirmare === false) {
      inregistreazaEsec(
        record,
        new Error('scrierea relațională a fost respinsă sau neconfirmată de registru'),
      );
      return false;
    }

    // A manager that reports nothing (an older implementation, or an injected
    // test double typed as returning void) leaves only the weaker signal: the
    // adapter's reachability plus the absence of a throw. Kept as a fallback so
    // no caller silently loses coverage, never as the primary evidence.
    if (confirmare !== true) {
      const adaptor = managerInjectat ? null : getSupabaseAdapter(mediu);
      const accesibil = adaptor ? adaptor.isAvailable : true;
      if (!accesibil) {
        inregistreazaEsec(record, new Error('scrierea relațională nu a fost confirmată'));
        return false;
      }
    }

    contoare.oglindite += 1;
    contoare.ultimul_seq_oglindit = Math.max(contoare.ultimul_seq_oglindit ?? 0, record.seq);
    contoare.ultima_reusita_la = new Date().toISOString();
    contoare.accesibil = true;
    return true;
  } catch (err) {
    inregistreazaEsec(record, err);
    return false;
  }
}

function inregistreazaEsec(record: AuditRecord, err: unknown): void {
  contoare.esuate += 1;
  contoare.accesibil = false;
  contoare.ultima_eroare = err instanceof Error ? err.message : String(err);
  if (persistentaEsteObligatorie()) {
    // PERSISTENCE_REQUIRED=true makes a mirroring failure a DEGRADATION that
    // health must expose. It does not make it a refusal: refusing belongs to the
    // request layer, not to the audit layer, which must never be able to
    // suppress the record of a decision that already happened.
    contoare.degradari += 1;
    logger.error(
      `oglindirea verigii seq=${record.seq} a eșuat cu PERSISTENCE_REQUIRED=true: ${contoare.ultima_eroare}`,
    );
  } else {
    logger.warn(`oglindirea verigii seq=${record.seq} a eșuat: ${contoare.ultima_eroare}`);
  }
}

/**
 * Fire-and-forget entry point called from `append()`. Returns synchronously and
 * cannot throw: the local chain has already been written when this runs, and no
 * relational fault may be allowed to travel back into that path.
 */
export function programeazaOglindire(record: AuditRecord): void {
  try {
    if (!persistentaEsteConfigurata()) {
      contoare.ultimul_seq_local = Math.max(contoare.ultimul_seq_local ?? 0, record.seq);
      return;
    }
    void oglindesteVeriga(record).catch((err) => {
      // Defence in depth: `oglindesteVeriga` already absorbs its own errors.
      contoare.ultima_eroare = err instanceof Error ? err.message : String(err);
      logger.warn(`oglindire respinsă neașteptat pentru seq=${record.seq}`);
    });
  } catch (err) {
    logger.warn(`programarea oglindirii a eșuat pentru seq=${record.seq}: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Sănătate
// ---------------------------------------------------------------------------

export interface RaportPersistenta {
  configurat: boolean;
  accesibil: boolean;
  motiv: string | null;
  ultimul_seq_oglindit: number | null;
  verigi_neoglindite: number | null;
  ultima_eroare: string | null;
  ultima_reusita_la: string | null;
  oglindite: number;
  esuate: number;
  degradari: number;
  degradat: boolean;
}

/**
 * Reachability probe with its OWN deadline and a short memo.
 *
 * Two faults are being avoided, and neither is hypothetical. First, the
 * adapter's request deadline is 10 s while the container probe that calls
 * `/health` gives up at 5 s: a register that HANGS rather than refuses would
 * make the probe expire and the orchestrator mark a correctly answering runtime
 * unhealthy — a fault caused entirely by the health check. Second, `/health`
 * and `/api/runtime/health` are polled every 30 s by probes and freely by
 * anyone; without a memo each call opens a fresh socket to the register.
 *
 * `LIMITA_INTEROGARE_MS` therefore stays well under the probe's own timeout, and
 * `TTL_MEMO_MS` under the polling interval, so freshness is never traded away.
 */
const LIMITA_INTEROGARE_MS = 2_000;
const TTL_MEMO_MS = 10_000;

let memoAccesibil: { valoare: boolean; la: number } | null = null;

async function interogheazaCuLimita(adaptor: { ping: () => Promise<boolean> }): Promise<boolean> {
  const acum = Date.now();
  if (memoAccesibil && acum - memoAccesibil.la < TTL_MEMO_MS) return memoAccesibil.valoare;

  let cronometru: NodeJS.Timeout | undefined;
  try {
    const valoare = await Promise.race<boolean>([
      adaptor.ping(),
      new Promise<boolean>((resolve) => {
        cronometru = setTimeout(() => resolve(false), LIMITA_INTEROGARE_MS);
        // Do not hold the event loop open on this timer.
        if (typeof cronometru.unref === 'function') cronometru.unref();
      }),
    ]);
    memoAccesibil = { valoare, la: Date.now() };
    return valoare;
  } finally {
    if (cronometru) clearTimeout(cronometru);
  }
}

/**
 * Honest persistence health. A configured-but-unreachable relational register
 * is a DEGRADED runtime, and an unconfigured one is degraded too, with the
 * reason stated. Reporting `healthy` in either case is the false green this
 * work exists to remove.
 */
export async function raporteazaPersistenta(seqLocalMaxim?: number): Promise<RaportPersistenta> {
  const stare = stareOglindire(seqLocalMaxim);

  if (!stare.configurat) {
    return {
      ...comun(stare),
      configurat: false,
      accesibil: false,
      motiv: 'persistență relațională neconfigurată (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absente)',
      degradat: true,
    };
  }

  let accesibil = false;
  let motiv: string | null = null;
  try {
    const adaptor = managerInjectat ? null : getSupabaseAdapter(mediu);
    if (adaptor) {
      accesibil = await interogheazaCuLimita(adaptor);
      if (!accesibil) motiv = 'baza de guvernanță configurată dar inaccesibilă';
    } else {
      // Injected manager (tests) or adapter absent: fall back to the observed
      // outcome of the last mirroring attempt rather than claiming reachability.
      accesibil = stare.accesibil === true;
      if (!accesibil) motiv = stare.ultima_eroare ?? 'accesibilitate neconfirmată';
    }
  } catch (err) {
    accesibil = false;
    motiv = err instanceof Error ? err.message : String(err);
  }
  contoare.accesibil = accesibil;

  return {
    ...comun(stare),
    configurat: true,
    accesibil,
    motiv,
    degradat: !accesibil,
  };
}

function comun(stare: StareOglindire): Omit<RaportPersistenta, 'configurat' | 'accesibil' | 'motiv' | 'degradat'> {
  return {
    ultimul_seq_oglindit: stare.ultimul_seq_oglindit,
    verigi_neoglindite: stare.verigi_neoglindite,
    ultima_eroare: stare.ultima_eroare,
    ultima_reusita_la: stare.ultima_reusita_la,
    oglindite: stare.oglindite,
    esuate: stare.esuate,
    degradari: stare.degradari,
  };
}
