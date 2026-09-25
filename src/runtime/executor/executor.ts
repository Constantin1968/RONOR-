/**
 * RONOR — executorul cu mandat (F07, cu F09 și F04)
 * ──────────────────────────────────────────────────
 * Singurul loc din runtime care produce un efect pe gazdă. Până acum, planul
 * R-Execution declara „executed” pentru apeluri de unelte fără să existe un
 * executor (F07, „execuție fictivă”). Aici starea `done` apare numai după ce
 * procesul sau cererea s-a încheiat, cu cod de ieșire, și e însoțită de o
 * chitanță semnată Ed25519 cu cheia privată a executorului.
 *
 * Semnăturile sunt asimetrice (D3): executorul are numai cheile publice ale
 * emitentului de mandate și ale oamenilor care aprobă, deci nu poate emite
 * mandate și nu poate aproba.
 *
 * Porțile, în ordine, înainte de orice efect:
 *   1. STOP (persistent în jurnal sau fișierul de STOP): nimic nu pornește;
 *   2. proveniența: cererea nu o poate declara (D4); un câmp `origin` în cerere
 *      e refuzat. Pentru `ops.actuate`, proveniența e în conținutul semnat al
 *      aprobării și trebuie să fie `operator`: o instrucțiune venită din
 *      memorie sau din ieșirea unui model e refuzată (F04), iar aprobarea ei e
 *      arsă. Pentru `ops.observe`, proveniența e mandatul semnat de emitent;
 *   3. mandatul: semnătura Ed25519 a emitentului, validitatea, revocarea;
 *   4. acțiunea tipizată: tipul trebuie delegat de mandat (`ops_observe`,
 *      `ops_actuate`), argumentele trec lista albă a operatorului;
 *   5. catalogul gazdei: ținta și verbul trebuie să existe în lista albă;
 *   6. pentru `ops.actuate`: aprobare semnată, legată de hash-ul acțiunii,
 *      neexpirată, nerevocată, de unică folosință;
 *   7. idempotența: aceeași aprobare nu produce a doua execuție (F09);
 *   8. contradicția: o a doua actuare pe aceeași unitate cât timp prima e în
 *      curs e refuzată, indiferent de deținător; apoi lease-ul pe resursă;
 *   9. starea unității (D2): `systemctl show` înainte de actuare; o unitate în
 *      `activating`, `deactivating` sau `reloading` are un job în curs (poate
 *      al unei execuții întrerupte) și actuarea e refuzată.
 *
 * În timpul execuției, STOP-ul și revocările se verifică periodic; oricare
 * dintre ele oprește clientul (SIGTERM, apoi SIGKILL pe grup) și, pentru o
 * actuare `systemd`, unitatea însăși (D1). Execuția se închide `interrupted`
 * numai după ce starea unității confirmă oprirea; altfel se închide
 * `interrupt_unconfirmed`. Niciuna nu are chitanță de succes.
 *
 * Executorul nu primește socketul Docker: la construire refuză să pornească
 * dacă vede `DOCKER_HOST` sau un socket Docker accesibil.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AutomationAction, ExecutionMandate } from '../automation/contracts';
import { ALWAYS_DENIED_ACTIONS, DEFAULT_ALLOWED_ACTIONS, objectiveHash, validateMandate } from '../automation/policy';
import { evaluateTypedOperatorAction, operatorTypesFromMandate } from '../operator/actions';
import { actionHash, verifyActuationApproval, type ActuationApproval } from './approval';
import { canonicalJson, sha256Hex } from './canonical';
import { planAction, type ExecutorCatalog, type SystemdControl } from './catalog';
import type { ExecutionRecord, ExecutorJournal } from './journal';
import { keyId, signDomain, verifyDomain, type PublicKeyring } from './keys';
import { createPlanRunner, queryUnitState, TRANSITIONAL_STATES, type PlanRunner, type UnitState } from './runner';

export const OPS_MANDATE_VERSION = 'ronor-ops-mandate/v2' as const;
export const RECEIPT_VERSION = 'ronor-execution-receipt/v2' as const;

export const DEFAULT_DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

export interface ExecutorConfig {
  catalog: ExecutorCatalog;
  journal: ExecutorJournal;
  /** Cheile publice ale emitentului de mandate de operațiuni. */
  mandateKeys: PublicKeyring;
  /** Cheile publice ale oamenilor care aprobă. */
  approvalKeys: PublicKeyring;
  /** Cheia privată proprie a executorului, folosită numai pentru chitanțe. */
  receiptKey: crypto.KeyObject;
  /** Fișier a cărui prezență înseamnă STOP; se poate crea din consolă, fără executor. */
  stopFile?: string;
  stopPollMs?: number;
  runner?: PlanRunner;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  dockerSockets?: string[];
  /** Citirea stării unei unități (D2 și confirmarea D1); implicit `systemctl show` din lista albă. */
  unitState?: (control: SystemdControl) => Promise<UnitState>;
}

export interface ExecutionRequest {
  mandate: ExecutionMandate;
  objective: string;
  action: unknown;
  owner: string;
  /** Pentru `ops.actuate`: aprobarea semnată, care poartă și proveniența. */
  approval?: unknown;
  /** Pentru `ops.observe`; la `ops.actuate` cheia este chiar `approval_id`. */
  idempotencyKey?: string;
}

export type ExecutionOutcome =
  | { state: 'refused'; reason: string }
  | {
      state: 'done' | 'failed' | 'interrupted' | 'interrupt_unconfirmed';
      reason: string | null;
      executionId: string;
      exitCode: number | null;
      output: string;
      receipt: string | null;
      replayed: boolean;
    };

export interface ExecutionReceiptBody {
  execution_id: string;
  host_id: string;
  mandate_id: string;
  action_hash: string;
  state: 'done' | 'failed';
  exit_code: number | null;
  output_sha256: string;
  finished_at: string;
}

function assertNoDockerAccess(env: NodeJS.ProcessEnv, sockets: string[]): void {
  if (env.DOCKER_HOST) throw new Error('executor_docker_access_forbidden:DOCKER_HOST');
  for (const socket of sockets) {
    try {
      fs.accessSync(socket, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      continue;
    }
    throw new Error(`executor_docker_access_forbidden:${socket}`);
  }
}

/**
 * Executorul are numai chei publice pentru mandat și aprobare și o singură cheie
 * privată, a chitanțelor. Rolurile nu se suprapun: cheia chitanțelor nu poate fi
 * și cheie de aprobare sau de mandat, iar o cheie nu poate fi în ambele inele.
 */
function validateKeys(config: ExecutorConfig): void {
  const ring = (value: unknown, label: string): PublicKeyring => {
    if (!(value instanceof Map) || value.size === 0) throw new Error(`executor_${label}_keys_missing`);
    for (const key of value.values()) {
      if (!(key instanceof crypto.KeyObject) || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error(`executor_${label}_keys_must_be_public_ed25519`);
    }
    return value as PublicKeyring;
  };
  const mandateKeys = ring(config.mandateKeys, 'mandate');
  const approvalKeys = ring(config.approvalKeys, 'approval');
  const receipt = config.receiptKey;
  if (!(receipt instanceof crypto.KeyObject) || receipt.type !== 'private' || receipt.asymmetricKeyType !== 'ed25519') throw new Error('executor_receipt_key_must_be_private_ed25519');
  const receiptId = keyId(receipt);
  if (mandateKeys.has(receiptId) || approvalKeys.has(receiptId)) throw new Error('executor_keys_must_be_distinct');
  for (const id of mandateKeys.keys()) if (approvalKeys.has(id)) throw new Error('executor_keys_must_be_distinct');
}

function opsMandatePayload(mandate: ExecutionMandate): string {
  const { authority_signature: _signature, ...signed } = mandate;
  return canonicalJson(signed);
}

/** Verifică mandatul de operațiuni: versiunea v2, emitentul din inel și semnătura Ed25519. */
export function verifyOperationsMandate(mandate: ExecutionMandate, issuerKeys: PublicKeyring): boolean {
  if (!mandate || typeof mandate !== 'object') return false;
  if ((mandate.authority_version as string) !== OPS_MANDATE_VERSION) return false;
  const key = issuerKeys.get(mandate.issued_by_key_id);
  if (!key) return false;
  try {
    return verifyDomain(OPS_MANDATE_VERSION, opsMandatePayload(mandate), mandate.authority_signature, key);
  } catch {
    return false;
  }
}

/** Contextul fix în care un mandat de operațiuni e valid: gazda, nu un arbore de lucru. */
export function opsMandateContext(hostId: string): { workspaceRoot: string; branch: string } {
  return { workspaceRoot: `ops://${hostId}`, branch: `ops/${hostId}` };
}

/** Emite un mandat de operațiuni: numai `ops_observe`, plus `ops_actuate` dacă e cerut explicit. */
export function issueOperationsMandate(
  request: { missionId: string; objective: string; hostId: string; allowActuate: boolean; ttlMinutes: number; now?: Date },
  issuerPrivateKey: crypto.KeyObject,
): ExecutionMandate {
  if (!(issuerPrivateKey instanceof crypto.KeyObject) || issuerPrivateKey.type !== 'private') throw new Error('mandate_signing_requires_private_key');
  if (!request.missionId || !request.objective.trim()) throw new Error('mandate_subject_invalid');
  if (!Number.isInteger(request.ttlMinutes) || request.ttlMinutes < 1 || request.ttlMinutes > 240) throw new Error('mandate_limit_outside_policy');
  const now = request.now ?? new Date();
  const allowed: AutomationAction[] = request.allowActuate ? ['ops_observe', 'ops_actuate'] : ['ops_observe'];
  const context = opsMandateContext(request.hostId);
  const unsigned: ExecutionMandate = {
      authority_version: OPS_MANDATE_VERSION,
      mandate_id: `mandate_${crypto.randomBytes(16).toString('hex')}`,
      mission_id: request.missionId,
      issued_by: 'merlin',
      issued_by_key_id: keyId(issuerPrivateKey),
      objective_hash: objectiveHash(request.objective),
      workspace_root: context.workspaceRoot,
      branch_prefix: context.branch,
      allowed_actions: allowed,
      denied_actions: [...ALWAYS_DENIED_ACTIONS, ...DEFAULT_ALLOWED_ACTIONS, ...(request.allowActuate ? [] : (['ops_actuate'] as AutomationAction[]))],
      max_cost_usd: 0,
      max_runtime_minutes: request.ttlMinutes,
      max_fix_cycles: 0,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + request.ttlMinutes * 60_000).toISOString(),
  };
  return { ...unsigned, authority_signature: signDomain(OPS_MANDATE_VERSION, opsMandatePayload(unsigned), issuerPrivateKey) };
}

/** Verifică o chitanță cu cheia publică a executorului; nu cere nicio cheie privată. */
export function verifyExecutionReceipt(body: ExecutionReceiptBody, receipt: unknown, executorPublicKey: crypto.KeyObject): boolean {
  return verifyDomain(RECEIPT_VERSION, canonicalJson(body), receipt, executorPublicKey);
}

export class MandatedExecutor {
  private readonly runner: PlanRunner;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, { controller: AbortController; mandateId: string; approvalId: string | null }>();

  private constructor(private readonly config: ExecutorConfig) {
    this.runner = config.runner ?? createPlanRunner();
    this.now = config.now ?? (() => new Date());
  }

  static create(config: ExecutorConfig): MandatedExecutor {
    validateKeys(config);
    assertNoDockerAccess(config.env ?? process.env, config.dockerSockets ?? DEFAULT_DOCKER_SOCKETS);
    return new MandatedExecutor(config);
  }

  get hostId(): string {
    return this.config.catalog.host_id;
  }

  // ── STOP și revocări ────────────────────────────────────────────────────
  /** STOP: persistent; oprește tot ce e în curs și refuză tot ce urmează, până la ridicarea explicită. */
  stop(reason: string): void {
    this.config.journal.setStop(true, reason, this.now());
    for (const flight of this.inFlight.values()) flight.controller.abort();
  }

  clearStop(by: string): void {
    this.config.journal.setStop(false, `ridicat de ${by}`, this.now());
  }

  revokeMandate(mandateId: string, reason: string): void {
    this.config.journal.revoke('mandate', mandateId, reason, this.now());
    for (const flight of this.inFlight.values()) if (flight.mandateId === mandateId) flight.controller.abort();
  }

  revokeApproval(approvalId: string, reason: string): void {
    this.config.journal.revoke('approval', approvalId, reason, this.now());
    for (const flight of this.inFlight.values()) if (flight.approvalId === approvalId) flight.controller.abort();
  }

  stopReason(): string | null {
    const state = this.config.journal.stopState();
    if (state.active) return `stop_active:${state.reason ?? 'fără motiv'}`;
    if (this.config.stopFile && fs.existsSync(this.config.stopFile)) return 'stop_active:fișier';
    return null;
  }

  /** Starea pe înregistrări, fără indicator global: ultima observare și ultima actuare, separat. */
  status(): { stop: string | null; lastObserve: ExecutionRecord | null; lastActuate: ExecutionRecord | null; inFlight: number } {
    return {
      stop: this.stopReason(),
      lastObserve: this.config.journal.lastOf('ops.observe'),
      lastActuate: this.config.journal.lastOf('ops.actuate'),
      inFlight: this.inFlight.size,
    };
  }

  // ── Execuția ────────────────────────────────────────────────────────────
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const now = this.now();
    const refused = (reason: string): ExecutionOutcome => ({ state: 'refused', reason });
    const journal = this.config.journal;

    const stopped = this.stopReason();
    if (stopped) return refused(stopped);

    // D4: proveniența nu mai e un câmp declarat de apelant.
    if (!request || typeof request !== 'object') return refused('request_malformed');
    if (Object.prototype.hasOwnProperty.call(request, 'origin')) return refused('request_origin_field_forbidden');
    if (typeof request.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,119}$/.test(request.owner)) return refused('owner_invalid');

    const mandate = request.mandate;
    if (!verifyOperationsMandate(mandate, this.config.mandateKeys)) return refused('mandate_authority_invalid');
    const context = opsMandateContext(this.hostId);
    const validation = validateMandate(mandate, { objective: request.objective, ...context, now });
    if (!validation.valid) return refused(`mandate_invalid:${validation.reason}`);
    if (journal.isRevoked('mandate', mandate.mandate_id)) return refused('mandate_revoked');

    const evaluation = evaluateTypedOperatorAction(request.action, operatorTypesFromMandate(mandate));
    if (!evaluation.allowed) return refused(evaluation.reason);
    const action = request.action as { type: 'ops.observe' | 'ops.actuate'; args: Record<string, unknown> };
    if (action.type !== 'ops.observe' && action.type !== 'ops.actuate') return refused('type_not_executable');

    const planned = planAction(this.config.catalog, action);
    if (!planned.ok) return refused(planned.reason);
    const { plan } = planned;

    const hash = actionHash({ host_id: this.hostId, mandate_id: mandate.mandate_id, type: action.type, args: action.args, resource: plan.resource });

    let approvalId: string | null = null;
    let idempotencyKey: string;
    if (action.type === 'ops.actuate') {
      // Reluarea aceleiași aprobări întoarce rezultatul înregistrat, înainte de verificarea expirării:
      // un răspuns pierdut nu trebuie să ducă la o a doua repornire.
      const candidate = request.approval as Partial<ActuationApproval> | undefined;
      if (candidate && typeof candidate.approval_id === 'string') {
        const previous = journal.findByApproval(candidate.approval_id);
        if (previous) {
          if (previous.action_hash !== hash) return refused('approval_already_used_for_other_action');
          return this.replay(previous);
        }
      }
      const check = verifyActuationApproval(request.approval, { mandateId: mandate.mandate_id, actionHash: hash, now }, this.config.approvalKeys);
      if (!check.ok) {
        // O aprobare autentică, dar cu altă proveniență decât `operator`, e arsă:
        // nu mai poate fi folosită, iar semnătura împiedică schimbarea provenienței.
        if (check.reason.startsWith('origin_not_authoritative:')) {
          journal.revoke('approval', (request.approval as ActuationApproval).approval_id, check.reason, now);
        }
        return refused(check.reason);
      }
      approvalId = (request.approval as ActuationApproval).approval_id;
      if (journal.isRevoked('approval', approvalId)) return refused('approval_revoked');
      idempotencyKey = `approval:${approvalId}`;
      if (journal.inFlightOn(plan.resource)) return refused('actuation_in_flight_on_resource');
    } else {
      if (request.idempotencyKey !== undefined && (typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(request.idempotencyKey)))
        return refused('idempotency_key_invalid');
      idempotencyKey = request.idempotencyKey
        ? `observe:${sha256Hex(`${mandate.mandate_id}\0${hash}\0${request.idempotencyKey}`)}`
        : `observe:${crypto.randomBytes(16).toString('hex')}`;
      const previous = journal.findByIdempotencyKey(idempotencyKey);
      if (previous) return this.replay(previous);
    }

    const leaseMs = plan.timeoutMs + 30_000;
    const lease = journal.claimLease(plan.resource, request.owner, leaseMs, now);
    if (lease.outcome === 'busy') return refused(`resource_busy:${lease.holder}`);

    // D2: jurnalul nu știe de joburile systemd rămase în curs (de exemplu, al unei
    // execuții întrerupte). Starea reală a unității se citește înainte de actuare.
    if (action.type === 'ops.actuate' && plan.kind === 'spawn' && plan.systemd) {
      const unitState = await (this.config.unitState ?? queryUnitState)(plan.systemd);
      const transitional = unitState.ok && TRANSITIONAL_STATES.includes(unitState.activeState);
      if (!unitState.ok || transitional) {
        journal.releaseLease(plan.resource, request.owner);
        return refused(unitState.ok ? `unit_in_transition:${unitState.activeState}` : unitState.reason);
      }
      const stopNow = this.stopReason();
      if (stopNow) {
        journal.releaseLease(plan.resource, request.owner);
        return refused(stopNow);
      }
    }

    const executionId = `exec_${crypto.randomBytes(16).toString('hex')}`;
    try {
      journal.admit({
        execution_id: executionId,
        idempotency_key: idempotencyKey,
        mandate_id: mandate.mandate_id,
        action_type: action.type,
        target: plan.resource,
        command: action.type === 'ops.actuate' ? String(action.args.command) : null,
        action_hash: hash,
        approval_id: approvalId,
        owner: request.owner,
        created_at: now.toISOString(),
      });
    } catch (error) {
      journal.releaseLease(plan.resource, request.owner);
      // O cursă pe aceeași aprobare: constrângerea UNIQUE a consumat-o deja în altă cerere.
      const previous = approvalId ? journal.findByApproval(approvalId) : journal.findByIdempotencyKey(idempotencyKey);
      if (previous) return this.replay(previous);
      return refused(`journal_write_failed:${(error as Error).message}`);
    }

    const controller = new AbortController();
    this.inFlight.set(executionId, { controller, mandateId: mandate.mandate_id, approvalId });
    const poll = setInterval(() => {
      if (this.stopReason() || journal.isRevoked('mandate', mandate.mandate_id) || journal.isRevoked('approval', approvalId)) controller.abort();
    }, this.config.stopPollMs ?? 250);

    try {
      // A doua verificare STOP, imediat înainte de efect: un STOP dat între admitere și pornire câștigă.
      const lateStop = this.stopReason();
      if (lateStop || controller.signal.aborted) {
        const at = this.now();
        journal.finish(executionId, { state: 'interrupted', reason: lateStop ?? 'stopped_before_start', exitCode: null, outputSha256: null, receipt: null, at });
        return { state: 'interrupted', reason: lateStop ?? 'stopped_before_start', executionId, exitCode: null, output: '', receipt: null, replayed: false };
      }
      journal.markStarted(executionId, this.now());
      const result = await this.runner(plan, controller.signal);
      const at = this.now();

      if (result.outcome === 'aborted' || controller.signal.aborted) {
        const why = this.stopReason() ?? (journal.isRevoked('mandate', mandate.mandate_id) ? 'mandate_revoked_during_execution' : 'approval_revoked_during_execution');
        // D1: `interrupted` numai după confirmarea că unitatea e inactivă.
        const unconfirmed = plan.kind === 'spawn' && plan.systemd !== undefined && !(result.halt && result.halt.confirmed);
        const state = unconfirmed ? 'interrupt_unconfirmed' : 'interrupted';
        const reason = result.halt ? `${why};unit=${result.halt.activeState ?? 'necunoscut'}/${result.halt.subState ?? 'necunoscut'}` : why;
        journal.finish(executionId, { state, reason, exitCode: result.exitCode, outputSha256: sha256Hex(result.output), receipt: null, at });
        return { state, reason, executionId, exitCode: result.exitCode, output: result.output, receipt: null, replayed: false };
      }
      if (result.outcome === 'timed_out' && result.halt && !result.halt.confirmed) {
        const reason = `timed_out;unit=${result.halt.activeState ?? 'necunoscut'}/${result.halt.subState ?? 'necunoscut'}`;
        journal.finish(executionId, { state: 'interrupt_unconfirmed', reason, exitCode: result.exitCode, outputSha256: sha256Hex(result.output), receipt: null, at });
        return { state: 'interrupt_unconfirmed', reason, executionId, exitCode: result.exitCode, output: result.output, receipt: null, replayed: false };
      }

      const succeeded =
        result.outcome === 'completed' &&
        (plan.kind === 'http_get' ? result.exitCode !== null && result.exitCode >= 200 && result.exitCode < 300 : result.exitCode === 0);
      const state: 'done' | 'failed' = succeeded ? 'done' : 'failed';
      const reason = succeeded ? null : `${result.outcome}:${result.exitCode ?? 'fără cod'}`;
      const body: ExecutionReceiptBody = {
        execution_id: executionId,
        host_id: this.hostId,
        mandate_id: mandate.mandate_id,
        action_hash: hash,
        state,
        exit_code: result.exitCode,
        output_sha256: sha256Hex(result.output),
        finished_at: at.toISOString(),
      };
      const receipt = signDomain(RECEIPT_VERSION, canonicalJson(body), this.config.receiptKey);
      journal.finish(executionId, { state, reason, exitCode: result.exitCode, outputSha256: body.output_sha256, receipt, at });
      return { state, reason, executionId, exitCode: result.exitCode, output: result.output, receipt, replayed: false };
    } finally {
      clearInterval(poll);
      this.inFlight.delete(executionId);
      journal.releaseLease(plan.resource, request.owner);
    }
  }

  private replay(record: ExecutionRecord): ExecutionOutcome {
    if (record.state === 'admitted' || record.state === 'started') return { state: 'refused', reason: 'execution_in_progress' };
    return {
      state: record.state,
      reason: record.reason,
      executionId: record.execution_id,
      exitCode: record.exit_code,
      output: '',
      receipt: record.receipt,
      replayed: true,
    };
  }
}
