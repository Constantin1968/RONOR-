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
import {
  loadSupabaseConfig,
  getSupabaseAdapter,
  type AuditEventRow,
  type StareRegistru,
} from './supabase-adapter';
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
  /**
   * Count of links in the observed window that the register never confirmed —
   * actual HOLES, not a distance between two high-water marks.
   */
  verigi_neoglindite: number | null;
  /**
   * The lowest sequence number this process has observed and NOT had confirmed:
   * the start of the window `verigi_neoglindite` counts over. Stated explicitly
   * because a count of holes without its window is not an auditable figure, and
   * because links written before this process started are unknown to it rather
   * than missing.
   */
  seq_prima_neoglindita: number | null;
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
  /**
   * Lowest sequence number seen by this process that is not yet confirmed. The
   * contiguous confirmed prefix is compacted into this number, so the set below
   * only ever holds links confirmed OUT OF ORDER — which keeps memory flat on the
   * healthy path instead of growing by one entry per audited decision.
   */
  seq_baza: number | null;
  /** Confirmed sequence numbers above `seq_baza` (the out-of-order stragglers). */
  seq_oglindite: Set<number>;
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
  seq_baza: null,
  seq_oglindite: new Set<number>(),
};

/**
 * Note a link seen on the local chain, and open the counting window at the first
 * one this process observes.
 */
function noteazaSeqLocal(seq: number): void {
  contoare.ultimul_seq_local = Math.max(contoare.ultimul_seq_local ?? 0, seq);
  if (contoare.seq_baza === null) contoare.seq_baza = seq;
}

/** Note a link the register CONFIRMED, then compact the contiguous prefix. */
function noteazaSeqOglindit(seq: number): void {
  contoare.ultimul_seq_oglindit = Math.max(contoare.ultimul_seq_oglindit ?? 0, seq);
  if (contoare.seq_baza === null) contoare.seq_baza = seq;
  if (seq < contoare.seq_baza) return;
  contoare.seq_oglindite.add(seq);
  while (contoare.seq_oglindite.delete(contoare.seq_baza)) {
    contoare.seq_baza += 1;
  }
}

/**
 * Number of links in `[seq_baza .. seqLocal]` that were never confirmed.
 *
 * The retired formula was `Math.max(0, seqLocal - (ultimul_seq_oglindit ?? 0))`,
 * a DISTANCE between two high-water marks. It reported zero missing links in the
 * case that matters most: mirror links 1–9, lose link 10, mirror link 11, and
 * the high-water mark reaches 11 while row 10 exists nowhere — `11 - 11 = 0`,
 * a hole in the audit trail reported as a complete trail. Counting membership
 * instead of subtracting maxima cannot produce that answer.
 */
function numaraVerigiNeoglindite(seqLocal: number | null): number | null {
  if (seqLocal === null) return null;
  const baza = contoare.seq_baza;
  if (baza === null) return null;
  if (seqLocal < baza) return 0;
  const fereastra = seqLocal - baza + 1;
  let confirmateInFereastra = 0;
  for (const s of contoare.seq_oglindite) {
    if (s >= baza && s <= seqLocal) confirmateInFereastra += 1;
  }
  return Math.max(0, fereastra - confirmateInFereastra);
}

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
  contoare.seq_baza = null;
  contoare.seq_oglindite.clear();
  managerInjectat = null;
  mediu = process.env;
  memoAccesibil = null;
  ultimaConfirmareLa = null;
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
  const neoglindite = numaraVerigiNeoglindite(seqLocal);
  return {
    configurat,
    accesibil: configurat ? contoare.accesibil : false,
    oglindite: contoare.oglindite,
    esuate: contoare.esuate,
    ultimul_seq_oglindit: contoare.ultimul_seq_oglindit,
    ultimul_seq_local: seqLocal,
    verigi_neoglindite: neoglindite,
    seq_prima_neoglindita: contoare.seq_baza,
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
  noteazaSeqLocal(record.seq);

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

    // A manager that reports nothing. On the PRODUCTION path this is now a
    // failure, full stop: the real manager always answers, so silence means an
    // implementation that cannot confirm its own write, and accepting it would
    // leave the retired reachability heuristic as a back door through which the
    // false green returns. Only an injected double (tests) keeps the weaker
    // signal — absence of a throw — and only because no adapter exists to ask.
    if (confirmare !== true) {
      if (!managerInjectat) {
        inregistreazaEsec(
          record,
          new Error('scrierea relațională nu a fost confirmată de managerul de memorie'),
        );
        return false;
      }
    }

    contoare.oglindite += 1;
    noteazaSeqOglindit(record.seq);
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
      noteazaSeqLocal(record.seq);
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
  /**
   * The register's own observed state when an adapter exists: `accesibil`,
   * `refuzat_autorizare`, `refuzat`, `inaccesibil`, `necunoscut`. Present so an
   * operator can tell a refusal that needs a credential rotated from an outage
   * that may heal by itself — `accesibil: false` alone cannot say which.
   */
  stare_registru: StareRegistru | null;
  ultimul_seq_oglindit: number | null;
  verigi_neoglindite: number | null;
  seq_prima_neoglindita: number | null;
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
 * the memo lives well under the polling interval, so freshness is never traded
 * away. Running out of time yields `nedeterminat` — never a verdict of absence.
 */
const LIMITA_INTEROGARE_MS = 2_000;
/**
 * Only a CONFIRMED contact is memoised, and briefly. A failure is never cached,
 * so recovery is visible on the very next call instead of up to a TTL later — a
 * stale `true` is the more dangerous of the two errors, and this bounds it.
 */
const TTL_MEMO_REUSITA_MS = 5_000;
/**
 * How long a confirmed contact keeps standing in for an inconclusive probe. Wide
 * enough to absorb one slow answer between two 30 s probe cycles, short enough
 * that a register which really went away is reported as gone.
 */
const FERESTRA_CONFIRMARE_MS = 60_000;

/** `nedeterminat` = the probe ran out of time. Slowness is not proof of absence. */
export type Accesibilitate = 'accesibil' | 'inaccesibil' | 'nedeterminat';

let memoAccesibil: { la: number } | null = null;
let ultimaConfirmareLa: number | null = null;

export async function interogheazaAccesibilitate(adaptor: {
  ping: () => Promise<boolean>;
}): Promise<Accesibilitate> {
  if (memoAccesibil && Date.now() - memoAccesibil.la < TTL_MEMO_REUSITA_MS) return 'accesibil';

  let cronometru: NodeJS.Timeout | undefined;
  try {
    // The probe keeps running after the race is lost, and its late answer is
    // still recorded. A register that answers in 3 s therefore teaches the next
    // call that it is alive, instead of being written off twice.
    const interogare: Promise<Accesibilitate> = adaptor.ping().then(
      (valoare) => {
        if (valoare) {
          ultimaConfirmareLa = Date.now();
          memoAccesibil = { la: ultimaConfirmareLa };
        } else {
          memoAccesibil = null;
        }
        return valoare ? 'accesibil' : 'inaccesibil';
      },
      () => {
        memoAccesibil = null;
        return 'inaccesibil';
      },
    );

    return await Promise.race<Accesibilitate>([
      interogare,
      new Promise<Accesibilitate>((resolve) => {
        cronometru = setTimeout(() => resolve('nedeterminat'), LIMITA_INTEROGARE_MS);
        // Do not hold the event loop open on this timer.
        if (typeof cronometru.unref === 'function') cronometru.unref();
      }),
    ]);
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
      stare_registru: null,
      motiv: 'persistență relațională neconfigurată (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absente)',
      degradat: true,
    };
  }

  let accesibil = false;
  let motiv: string | null = null;
  let stareRegistru: StareRegistru | null = null;
  try {
    const adaptor = managerInjectat ? null : getSupabaseAdapter(mediu);
    if (adaptor) {
      const stareAcces = await interogheazaAccesibilitate(adaptor);
      stareRegistru = adaptor.stareRegistru;
      if (stareAcces === 'accesibil') {
        accesibil = true;
      } else if (stareAcces === 'inaccesibil') {
        accesibil = false;
        // The adapter distinguishes a refusal from an outage; carrying its own
        // reason forward means a 401 is reported as an expired authorisation
        // instead of as an unreachable database, which sends the operator to the
        // wrong place.
        motiv = adaptor.motivulStarii ?? 'baza de guvernanță configurată dar inaccesibilă';
      } else {
        // Inconclusive, not negative. Left as a refusal, one slow answer would
        // withdraw readiness once persistence is mandatory and stop every
        // service that waits on this runtime — an outage manufactured by the
        // health check itself. A recent confirmed contact therefore stands in,
        // and the delay is stated rather than hidden.
        const varsta = ultimaConfirmareLa === null ? null : Date.now() - ultimaConfirmareLa;
        accesibil = varsta !== null && varsta < FERESTRA_CONFIRMARE_MS;
        motiv = accesibil
          ? `interogare peste termenul de ${LIMITA_INTEROGARE_MS} ms; ultima confirmare acum ${Math.round((varsta as number) / 1000)} s`
          : `interogare peste termenul de ${LIMITA_INTEROGARE_MS} ms, fără confirmare recentă`;
      }
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

  // Health judges CONFIRMED WRITES, not reachability alone. A register that is
  // answering while links 10 and 14 exist only on the local chain is not a
  // healthy register: the two trails no longer reconcile, and reporting green
  // would leave the gap to be discovered during an audit rather than now.
  const gauri = stare.verigi_neoglindite;
  const motiveDegradare: string[] = [];
  if (!accesibil) motiveDegradare.push(motiv ?? 'accesibilitate neconfirmată');
  if (gauri !== null && gauri > 0) {
    motiveDegradare.push(
      `${gauri} verigă${gauri === 1 ? '' : 'i'} neconfirmată${gauri === 1 ? '' : 'e'} de registru ` +
        `de la seq=${stare.seq_prima_neoglindita ?? '?'} până la seq=${stare.ultimul_seq_local ?? '?'}`,
    );
  }

  return {
    ...comun(stare),
    configurat: true,
    accesibil,
    stare_registru: stareRegistru,
    // When nothing degrades, any informative note the probe produced (a slow but
    // confirmed answer, say) is still reported rather than dropped.
    motiv: motiveDegradare.length > 0 ? motiveDegradare.join('; ') : motiv,
    degradat: motiveDegradare.length > 0,
  };
}

function comun(
  stare: StareOglindire,
): Omit<RaportPersistenta, 'configurat' | 'accesibil' | 'motiv' | 'degradat' | 'stare_registru'> {
  return {
    ultimul_seq_oglindit: stare.ultimul_seq_oglindit,
    verigi_neoglindite: stare.verigi_neoglindite,
    seq_prima_neoglindita: stare.seq_prima_neoglindita,
    ultima_eroare: stare.ultima_eroare,
    ultima_reusita_la: stare.ultima_reusita_la,
    oglindite: stare.oglindite,
    esuate: stare.esuate,
    degradari: stare.degradari,
  };
}
