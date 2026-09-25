/**
 * Executorul cu mandat: porți, aprobare legată de hash și expirare, STOP,
 * idempotență, contradicție, proveniență și absența accesului Docker.
 *
 * Efectul real e un proces: un `systemctl` fals (script /bin/sh) într-un
 * director temporar, care scrie în fișierul de urme fiecare apel. Pentru proba
 * STOP pe o acțiune în curs, unitatea `ronor-lent.service` doarme 30 s; testul
 * cere oprirea în câteva sute de milisecunde.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import { operatorTypesFromMandate, OPERATOR_TYPE_MANDATE_ACTION } from '../../src/runtime/operator/actions';
import { runOperatorTick } from '../../src/runtime/operator/loop';
import { ResourceLeaseManager } from '../../src/runtime/operator/resource-lease';
import { AUTOMATION_ACTIONS } from '../../src/runtime/automation/contracts';
import { DEFAULT_ALLOWED_ACTIONS } from '../../src/runtime/automation/policy';
import {
  actionHash,
  ExecutorJournal,
  issueOperationsMandate,
  MandatedExecutor,
  MAX_APPROVAL_TTL_MS,
  parseExecutorCatalog,
  signActuationApproval,
  verifyExecutionReceipt,
  type ExecutionOutcome,
} from '../../src/runtime/executor';
import { RExecutionPlane } from '../../src/planes/r-execution';

jest.setTimeout(20_000);

// Chei de probă, fără valoare în afara testului; construite, nu literale.
const fixtureKey = (label: string) => `proba-${label}-`.padEnd(48, '0');
const MANDATE_KEY = fixtureKey('mandat');
const APPROVAL_KEY = fixtureKey('aprobare');
const RECEIPT_KEY = fixtureKey('chitanta');
const OBJECTIVE = 'Repornește runtime-ul RONOR pe gazda de probă';
const HOST = 'gazda-proba';
const ARCHITECT = 'key_0123456789ab';
const APPROVER = 'key_abcdefabcdef';

let dir: string;
let trace: string;
let catalogJson: Record<string, unknown>;

function calls(): string[] {
  return fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-executor-'));
  trace = path.join(dir, 'urme.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    [
      '#!/bin/sh',
      `echo "start $*" >> '${trace}'`,
      'case "$*" in',
      '  *ronor-lent.service*) exec /bin/sleep 30 ;;',
      '  *ronor-cade.service*) echo "Job failed" >&2; exit 1 ;;',
      '  show*) echo "ActiveState=active"; echo "SubState=running" ;;',
      'esac',
      `echo "gata $*" >> '${trace}'`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  catalogJson = {
    host_id: HOST,
    systemctl: [path.join(bin, 'systemctl')],
    entries: [
      { id: 'runtime', type: 'ops.observe', kind: 'systemd_status', unit: 'ronor-runtime.service', timeout_ms: 5_000 },
      { id: 'runtime', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-runtime.service', commands: ['restart'], timeout_ms: 5_000 },
      { id: 'lent', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-lent.service', commands: ['restart', 'stop'], timeout_ms: 60_000 },
      { id: 'cade', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-cade.service', commands: ['restart'], timeout_ms: 5_000 },
    ],
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(overrides: Record<string, unknown> = {}) {
  const journal = new ExecutorJournal(path.join(dir, 'jurnal.db'));
  const executor = MandatedExecutor.create({
    catalog: parseExecutorCatalog(catalogJson),
    journal,
    mandateSecret: MANDATE_KEY,
    approvalSecret: APPROVAL_KEY,
    receiptSecret: RECEIPT_KEY,
    stopPollMs: 25,
    env: {},
    dockerSockets: [path.join(dir, 'nu-exista.sock')],
    ...overrides,
  });
  return { executor, journal };
}

function opsMandate(allowActuate = true) {
  return issueOperationsMandate({ missionId: 'misiune-ops-001', objective: OBJECTIVE, hostId: HOST, architectKeyId: ARCHITECT, allowActuate, ttlMinutes: 30 }, MANDATE_KEY);
}

function approve(mandateId: string, device: string, command: string, overrides: { ttlMs?: number; now?: Date; key?: string } = {}) {
  const hash = actionHash({ host_id: HOST, mandate_id: mandateId, type: 'ops.actuate', args: { device, command }, resource: `unit:ronor-${device}.service` });
  return signActuationApproval({ mandateId, actionHash: hash, approverKeyId: APPROVER, ttlMs: overrides.ttlMs ?? 300_000, now: overrides.now }, overrides.key ?? APPROVAL_KEY);
}

function actuate(mandate: ReturnType<typeof opsMandate>, device: string, command: string, approval: unknown, origin: 'operator' | 'memory' | 'model' = 'operator') {
  return { mandate, objective: OBJECTIVE, owner: 'operator-1', origin, action: { type: 'ops.actuate', args: { device, command } }, approval };
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('condiția nu s-a îndeplinit la timp');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('vocabularul mandatului', () => {
  it('are acțiuni proprii pentru ops.observe și ops.actuate, în afara mandatului implicit de dezvoltare', () => {
    expect(AUTOMATION_ACTIONS).toEqual(expect.arrayContaining(['ops_observe', 'ops_actuate']));
    expect(OPERATOR_TYPE_MANDATE_ACTION['ops.observe']).toBe('ops_observe');
    expect(OPERATOR_TYPE_MANDATE_ACTION['ops.actuate']).toBe('ops_actuate');
    expect(DEFAULT_ALLOWED_ACTIONS).not.toContain('ops_observe');
    expect(DEFAULT_ALLOWED_ACTIONS).not.toContain('ops_actuate');
    expect(operatorTypesFromMandate(opsMandate(false))).toEqual(['ops.observe']);
    expect(operatorTypesFromMandate(opsMandate(true))).toEqual(['ops.observe', 'ops.actuate']);
  });
});

describe('construirea executorului', () => {
  it('refuză să pornească cu acces Docker (DOCKER_HOST sau socket accesibil)', () => {
    expect(() => build({ env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } })).toThrow('executor_docker_access_forbidden:DOCKER_HOST');
    const socket = path.join(dir, 'docker.sock');
    fs.writeFileSync(socket, '');
    expect(() => build({ dockerSockets: [socket] })).toThrow(`executor_docker_access_forbidden:${socket}`);
  });

  it('cere trei chei distincte, de cel puțin 32 de octeți', () => {
    expect(() => build({ approvalSecret: MANDATE_KEY })).toThrow('executor_secrets_must_be_distinct');
    expect(() => build({ receiptSecret: 'scurt' })).toThrow('executor_secret_invalid');
  });

  it('lista albă refuză unitățile Docker și de sistem, adresele din afara loopback și alte binare decât systemctl', () => {
    const bad = (patch: Record<string, unknown>) => () => parseExecutorCatalog({ ...catalogJson, ...patch });
    const entry = (e: Record<string, unknown>) => bad({ entries: [e] });
    expect(entry({ id: 'd', type: 'ops.actuate', kind: 'systemd', unit: 'docker.service', commands: ['restart'], timeout_ms: 1000 })).toThrow(/unit_forbidden/);
    expect(entry({ id: 'd', type: 'ops.actuate', kind: 'systemd', unit: 'sshd.service', commands: ['restart'], timeout_ms: 1000 })).toThrow(/unit_forbidden/);
    expect(entry({ id: 'd', type: 'ops.actuate', kind: 'systemd', unit: 'ronor.service', commands: ['kill'], timeout_ms: 1000 })).toThrow(/command:kill/);
    expect(entry({ id: 'h', type: 'ops.observe', kind: 'http_get', url: 'http://10.0.0.5:3000/health', timeout_ms: 1000 })).toThrow(/url_not_loopback/);
    expect(entry({ id: 'h', type: 'ops.observe', kind: 'http_get', url: 'http://127.0.0.1:3000/health', timeout_ms: 1000, argv: ['x'] })).toThrow(/unknown_key:argv/);
    expect(bad({ systemctl: ['/usr/bin/docker'] })).toThrow(/not_systemctl/);
    expect(bad({ systemctl: ['/usr/bin/sudo', '/usr/bin/systemctl'] })).toThrow(/sudo_must_be_non_interactive/);
    expect(bad({ systemctl: ['/bin/sh', '-c', '/usr/bin/systemctl'] })).toThrow(/wrapper_not_sudo/);
    expect(() => parseExecutorCatalog({ ...catalogJson, host_id: HOST, systemctl: ['/usr/bin/sudo', '-n', '/usr/bin/systemctl'] })).not.toThrow();
  });
});

describe('observare și actuare', () => {
  it('observă din lista albă și semnează rezultatul; nu actuează cu mandat numai de observare', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate(false);
    const outcome = await executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', origin: 'operator', action: { type: 'ops.observe', args: { target: 'runtime' } } });
    expect(outcome.state).toBe('done');
    if (outcome.state === 'refused') throw new Error('refuzat');
    expect(outcome.output).toContain('ActiveState=active');
    const record = journal.get(outcome.executionId)!;
    expect(verifyExecutionReceipt(
      { execution_id: record.execution_id, host_id: HOST, mandate_id: mandate.mandate_id, action_hash: record.action_hash, state: 'done', exit_code: 0, output_sha256: record.output_sha256!, finished_at: record.finished_at! },
      outcome.receipt, RECEIPT_KEY,
    )).toBe(true);
    const refused = await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')));
    expect(refused).toEqual({ state: 'refused', reason: 'action_not_allowed:ops.actuate' });
    expect(calls().filter((c) => c.includes('restart'))).toEqual([]);
    journal.close();
  });

  it('refuză ținte, verbe și argumente din afara listei albe, înainte de orice proces', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const run = (args: Record<string, unknown>, type = 'ops.actuate') =>
      executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', origin: 'operator', action: { type, args }, approval: approve(mandate.mandate_id, 'runtime', 'restart') });
    expect(await run({ device: 'docker', command: 'restart' })).toEqual({ state: 'refused', reason: 'device_not_in_allowlist' });
    expect(await run({ device: 'runtime', command: 'stop' })).toEqual({ state: 'refused', reason: 'command_not_in_allowlist' });
    expect(await run({ device: 'runtime', command: 'restart; rm -rf /' })).toEqual({ state: 'refused', reason: 'invalid_args' });
    expect(await run({ device: 'runtime', command: 'restart', extra: 'x' })).toEqual({ state: 'refused', reason: 'unknown_arg:extra' });
    expect(await run({ target: 'necunoscut' }, 'ops.observe')).toEqual({ state: 'refused', reason: 'target_not_in_allowlist' });
    expect(calls()).toEqual([]);
    journal.close();
  });

  it('refuză o cerere venită din memorie sau din ieșirea unui model, chiar cu aprobare validă (F04)', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const approval = approve(mandate.mandate_id, 'runtime', 'restart');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval, 'memory'))).toEqual({ state: 'refused', reason: 'origin_not_authoritative:memory' });
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval, 'model'))).toEqual({ state: 'refused', reason: 'origin_not_authoritative:model' });
    expect(calls()).toEqual([]);
    journal.close();
  });

  it('refuză un mandat nesemnat de autoritate sau revocat', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const forged = signMandateAuthority({ ...mandate, authority_signature: undefined }, fixtureKey('alta-autoritate'));
    expect(await executor.execute(actuate(forged, 'runtime', 'restart', approve(forged.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'mandate_authority_invalid' });
    executor.revokeMandate(mandate.mandate_id, 'probă');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'mandate_revoked' });
    expect(calls()).toEqual([]);
    journal.close();
  });
});

describe('aprobarea pentru ops.actuate e legată de acțiunea exactă și expiră', () => {
  it('refuză lipsa aprobării, altă acțiune, alt mandat, semnătura falsă, expirarea și durata prea lungă', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const other = opsMandate();
    const reason = async (approval: unknown) => ((await executor.execute(actuate(mandate, 'lent', 'restart', approval))) as { reason: string }).reason;
    expect(await reason(undefined)).toBe('approval_malformed');
    expect(await reason(true)).toBe('approval_malformed');
    expect(await reason(approve(mandate.mandate_id, 'lent', 'stop'))).toBe('approval_action_mismatch');
    expect(await reason(approve(mandate.mandate_id, 'runtime', 'restart'))).toBe('approval_action_mismatch');
    expect(await reason(approve(other.mandate_id, 'lent', 'restart'))).toBe('approval_mandate_mismatch');
    expect(await reason(approve(mandate.mandate_id, 'lent', 'restart', { key: fixtureKey('alta-aprobare') }))).toBe('approval_signature_invalid');
    const tampered = { ...approve(mandate.mandate_id, 'lent', 'restart'), expires_at: new Date(Date.now() + 60 * 60_000).toISOString() };
    expect(await reason(tampered)).toBe('approval_signature_invalid');
    expect(await reason(approve(mandate.mandate_id, 'lent', 'restart', { ttlMs: 60_000, now: new Date(Date.now() - 120_000) }))).toBe('approval_expired');
    expect(() => approve(mandate.mandate_id, 'lent', 'restart', { ttlMs: MAX_APPROVAL_TTL_MS + 1 })).toThrow('approval_ttl_outside_policy');
    expect(calls()).toEqual([]);
    journal.close();
  });

  it('execută o dată; reluarea aceleiași aprobări întoarce rezultatul înregistrat, fără a doua execuție (F09)', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const approval = approve(mandate.mandate_id, 'runtime', 'restart');
    const first = await executor.execute(actuate(mandate, 'runtime', 'restart', approval));
    expect(first).toMatchObject({ state: 'done', exitCode: 0, replayed: false });
    const second = await executor.execute(actuate(mandate, 'runtime', 'restart', approval));
    expect(second).toMatchObject({ state: 'done', replayed: true, executionId: (first as { executionId: string }).executionId });
    expect(calls().filter((c) => c.startsWith('start restart'))).toHaveLength(1);
    journal.close();
  });

  it('un eșec de actuare rămâne vizibil după o observare reușită (fără indicator global, F09)', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const failed = await executor.execute(actuate(mandate, 'cade', 'restart', approve(mandate.mandate_id, 'cade', 'restart')));
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 });
    expect((failed as { receipt: string | null }).receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', origin: 'operator', action: { type: 'ops.observe', args: { target: 'runtime' } } });
    const status = executor.status();
    expect(status.lastObserve?.state).toBe('done');
    expect(status.lastActuate?.state).toBe('failed');
    expect(status.lastActuate?.reason).toBe('completed:1');
    journal.close();
  });
});

describe('proba STOP', () => {
  it('o acțiune aprobată nu se mai execută după STOP; după ridicarea STOP, aceeași aprobare încă nefolosită trece', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const approval = approve(mandate.mandate_id, 'runtime', 'restart');
    executor.stop('probă STOP');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval))).toEqual({ state: 'refused', reason: 'stop_active:probă STOP' });
    expect(calls()).toEqual([]);
    // STOP-ul e persistent: un executor nou pe același jurnal îl vede.
    const reopened = build();
    expect(reopened.executor.stopReason()).toBe('stop_active:probă STOP');
    reopened.journal.close();
    executor.clearStop('operator-1');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval))).toMatchObject({ state: 'done' });
    journal.close();
  });

  it('fișierul de STOP, creat fără executor, blochează la fel', async () => {
    const stopFile = path.join(dir, 'STOP');
    const { executor, journal } = build({ stopFile });
    const mandate = opsMandate();
    fs.writeFileSync(stopFile, '');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'stop_active:fișier' });
    expect(calls()).toEqual([]);
    journal.close();
  });

  async function startSlow(executor: MandatedExecutor, mandate: ReturnType<typeof opsMandate>, nth = 1) {
    const pending = executor.execute(actuate(mandate, 'lent', 'restart', approve(mandate.mandate_id, 'lent', 'restart')));
    await waitFor(() => calls().filter((c) => c.startsWith('start restart -- ronor-lent.service')).length >= nth);
    // Obiect, nu promisiune: `await` pe funcția asincronă nu trebuie să aștepte sfârșitul execuției.
    return { pending };
  }

  it('o acțiune în curs e oprită de STOP: procesul e terminat, starea e interrupted, nu done', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const started = Date.now();
    const { pending } = await startSlow(executor, mandate);
    executor.stop('probă STOP în curs');
    const outcome = (await pending) as Extract<ExecutionOutcome, { executionId: string }>;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.state).toBe('interrupted');
    expect(outcome.reason).toBe('stop_active:probă STOP în curs');
    expect(outcome.receipt).toBeNull();
    expect(journal.get(outcome.executionId)?.state).toBe('interrupted');
    expect(calls().some((c) => c.startsWith('gata restart'))).toBe(false);
    expect(journal.leaseHolder('unit:ronor-lent.service', new Date())).toBeNull();
    journal.close();
  });

  it('STOP dat din alt proces (alt executor pe același jurnal) sau prin fișier oprește acțiunea în curs', async () => {
    const stopFile = path.join(dir, 'STOP');
    const { executor, journal } = build({ stopFile });
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate);
    const other = build();
    other.executor.stop('din consolă');
    other.journal.close();
    expect(await pending).toMatchObject({ state: 'interrupted', reason: 'stop_active:din consolă' });

    executor.clearStop('operator-1');
    const again = await startSlow(executor, mandate, 2);
    fs.writeFileSync(stopFile, '');
    expect(await again.pending).toMatchObject({ state: 'interrupted', reason: 'stop_active:fișier' });
    journal.close();
  });

  it('revocarea mandatului oprește acțiunea în curs', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate);
    executor.revokeMandate(mandate.mandate_id, 'probă');
    expect(await pending).toMatchObject({ state: 'interrupted', reason: 'mandate_revoked_during_execution' });
    journal.close();
  });
});

describe('contradicție, lease și repornire', () => {
  it('o a doua actuare pe aceeași unitate, cât prima e în curs, e refuzată indiferent de deținător', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const pending = executor.execute(actuate(mandate, 'lent', 'restart', approve(mandate.mandate_id, 'lent', 'restart')));
    await waitFor(() => calls().length === 1);
    const contradictory = await executor.execute(actuate(mandate, 'lent', 'stop', approve(mandate.mandate_id, 'lent', 'stop')));
    expect(contradictory).toEqual({ state: 'refused', reason: 'actuation_in_flight_on_resource' });
    executor.stop('curățenie');
    await pending;
    journal.close();
  });

  it('lease-ul e persistent și reentrant pentru același deținător', () => {
    const journal = new ExecutorJournal(path.join(dir, 'lease.db'));
    const now = new Date();
    expect(journal.claimLease('unit:a', 'o1', 60_000, now)).toEqual({ outcome: 'acquired', depth: 1 });
    expect(journal.claimLease('unit:a', 'o1', 60_000, now)).toEqual({ outcome: 'acquired', depth: 2 });
    expect(journal.claimLease('unit:a', 'o2', 60_000, now)).toEqual({ outcome: 'busy', holder: 'o1' });
    journal.close();
    const reopened = new ExecutorJournal(path.join(dir, 'lease.db'));
    expect(reopened.leaseHolder('unit:a', now)).toEqual({ owner: 'o1', depth: 2 });
    expect(reopened.releaseLease('unit:a', 'o1')).toBe(true);
    expect(reopened.claimLease('unit:a', 'o2', 60_000, now)).toEqual({ outcome: 'busy', holder: 'o1' });
    expect(reopened.releaseLease('unit:a', 'o1')).toBe(true);
    expect(reopened.claimLease('unit:a', 'o2', 60_000, now)).toEqual({ outcome: 'acquired', depth: 1 });
    reopened.close();
  });

  it('după o repornire, o execuție rămasă „started” devine interrupted și nu se reia', () => {
    const file = path.join(dir, 'restart.db');
    const journal = new ExecutorJournal(file);
    journal.admit({ execution_id: 'exec_1', idempotency_key: 'approval:appr_1', mandate_id: 'm', action_type: 'ops.actuate', target: 'unit:x', command: 'restart', action_hash: 'h', approval_id: 'appr_1', owner: 'o', created_at: new Date().toISOString() });
    journal.markStarted('exec_1', new Date());
    // Cât timp procesul care a pornit execuția trăiește, redeschiderea nu o atinge.
    const concurrent = new ExecutorJournal(file);
    expect(concurrent.get('exec_1')?.state).toBe('started');
    concurrent.close();
    journal.close();
    // Simulează moartea procesului: pid-ul înregistrat nu mai există.
    const raw = new Database(file);
    raw.prepare('UPDATE executions SET pid = ? WHERE execution_id = ?').run(2147483646, 'exec_1');
    raw.close();
    const reopened = new ExecutorJournal(file);
    expect(reopened.get('exec_1')).toMatchObject({ state: 'interrupted', reason: 'process_restart_outcome_unknown' });
    expect(() => reopened.finish('exec_1', { state: 'done', reason: null, exitCode: 0, outputSha256: null, receipt: null, at: new Date() })).toThrow('executor_journal_transition_refused:done');
    reopened.close();
  });
});

describe('bucla operatorului: aprobarea legată de hash', () => {
  const mandate = () => opsMandate();
  const tick = (m: ReturnType<typeof opsMandate>, extra: Record<string, unknown>) =>
    runOperatorTick({
      mandate: m,
      objective: OBJECTIVE,
      workspaceRoot: `ops://${HOST}`,
      branch: `ops/${HOST}`,
      resource: 'unit:ronor-runtime.service',
      owner: 'operator-1',
      action: { type: 'ops.actuate', args: { device: 'runtime', command: 'restart' } },
      costSoFarUsd: 0,
      leaseManager: new ResourceLeaseManager(),
      ...extra,
    } as Parameters<typeof runOperatorTick>[0]);

  it('booleanul approved nu mai autorizează; trece numai aprobarea semnată pentru acțiunea exactă', () => {
    const m = mandate();
    // max_cost_usd al mandatului de operațiuni e 0: bucla îl tratează drept buget epuizat.
    const funded = signMandateAuthority({ ...m, max_cost_usd: 1, authority_signature: undefined }, MANDATE_KEY);
    expect(tick(funded, { approved: true })).toEqual({ decision: 'blocked', reason: 'approval_required' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart') })).toEqual({ decision: 'blocked', reason: 'approval_verifier_unavailable' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart'), approvalSecret: APPROVAL_KEY, hostId: HOST })).toEqual({ decision: 'ready_to_execute', reason: 'operator_tick_permitted' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'lent', 'restart'), approvalSecret: APPROVAL_KEY, hostId: HOST })).toEqual({ decision: 'blocked', reason: 'approval_action_mismatch' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart'), approvalSecret: APPROVAL_KEY, hostId: 'alta-gazda' })).toEqual({ decision: 'blocked', reason: 'approval_action_mismatch' });
  });
});

describe('R-Execution nu mai declară execuții fictive (F07)', () => {
  it('refuză apelurile de unelte fără executor și raportează degraded', async () => {
    const plane = new RExecutionPlane();
    const result = await plane.process({
      agentSteps: [{ toolCall: { name: 'shell', params: { cmd: 'ls' } } }],
    } as unknown as Parameters<RExecutionPlane['process']>[0]);
    expect(result.toolsInvoked).toBe(0);
    expect(result.toolCalls).toEqual([{ name: 'shell', state: 'refused', reason: 'executor_unavailable' }]);
    expect(result.executionLog.join('\n')).not.toMatch(/— executed/);
    expect((await plane.health()).status).toBe('degraded');
  });
});
