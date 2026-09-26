/**
 * Executorul cu mandat: porți, aprobare Ed25519 legată de hash, proveniență și
 * expirare, STOP cu efectul verificat, starea unității, idempotență,
 * contradicție și absența accesului Docker.
 *
 * Efectul real e o unitate fictivă care imită systemd (`tests/executor/fake-systemd.ts`):
 * `systemctl start` e numai clientul, iar procesul unității rulează separat, în
 * propria sesiune și propriul grup de procese, ca un copil al lui PID 1.
 * Uciderea clientului nu oprește unitatea; numai `systemctl stop`/`kill` o
 * oprește. Proba STOP verifică deci efectul (lipsa marcajului `final` și
 * starea `inactive`), nu doar terminarea clientului.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { operatorTypesFromMandate, OPERATOR_TYPE_MANDATE_ACTION } from '../../src/runtime/operator/actions';
import { runOperatorTick } from '../../src/runtime/operator/loop';
import { ResourceLeaseManager } from '../../src/runtime/operator/resource-lease';
import { AUTOMATION_ACTIONS } from '../../src/runtime/automation/contracts';
import { DEFAULT_ALLOWED_ACTIONS } from '../../src/runtime/automation/policy';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import {
  actionHash,
  ExecutorJournal,
  issueOperationsMandate,
  keyId,
  keyringFrom,
  MandatedExecutor,
  MAX_APPROVAL_TTL_MS,
  parseExecutorCatalog,
  parsePublicKeyring,
  signActuationApproval,
  verifyActuationApproval,
  verifyExecutionReceipt,
  verifyOperationsMandate,
  createPlanRunner,
  type ExecutionOutcome,
  type RequestOrigin,
} from '../../src/runtime/executor';
import { RExecutionPlane } from '../../src/planes/r-execution';
import { createFakeSystemd, type FakeSystemd } from './fake-systemd';

jest.setTimeout(30_000);

// Chei de probă Ed25519, generate la rulare; nu există în afara testului.
const pair = () => crypto.generateKeyPairSync('ed25519');
const ISSUER = pair();
const APPROVER = pair();
const EXECUTOR = pair();
const MANDATE_KEYS = keyringFrom([ISSUER.publicKey]);
const APPROVAL_KEYS = keyringFrom([APPROVER.publicKey]);
const OBJECTIVE = 'Repornește runtime-ul RONOR pe gazda de probă';
const HOST = 'gazda-proba';

let dir: string;
let sd: FakeSystemd;
let catalogJson: Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-executor-'));
  sd = createFakeSystemd(dir, {
    'ronor-runtime.service': {},
    'ronor-lent.service': { delaySec: 2 },
    'ronor-cade.service': { fail: true },
    'ronor-tenace.service': { delaySec: 3, stubborn: true },
  });
  catalogJson = {
    host_id: HOST,
    systemctl: [sd.systemctl],
    entries: [
      { id: 'runtime', type: 'ops.observe', kind: 'systemd_status', unit: 'ronor-runtime.service', timeout_ms: 5_000 },
      { id: 'runtime', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-runtime.service', commands: ['restart', 'start'], timeout_ms: 5_000 },
      { id: 'lent', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-lent.service', commands: ['restart', 'start', 'stop'], timeout_ms: 60_000 },
      { id: 'cade', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-cade.service', commands: ['restart'], timeout_ms: 5_000 },
      { id: 'tenace', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-tenace.service', commands: ['start'], timeout_ms: 60_000 },
    ],
  };
});

afterEach(() => {
  sd.killAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(overrides: Record<string, unknown> = {}) {
  const journal = new ExecutorJournal(path.join(dir, 'jurnal.db'));
  const executor = MandatedExecutor.create({
    catalog: parseExecutorCatalog(catalogJson),
    journal,
    mandateKeys: MANDATE_KEYS,
    approvalKeys: APPROVAL_KEYS,
    receiptKey: EXECUTOR.privateKey,
    stopPollMs: 25,
    env: {},
    dockerSockets: [path.join(dir, 'nu-exista.sock')],
    runner: createPlanRunner({ killGraceMs: 500, confirmMs: 600, pollMs: 50, haltTimeoutMs: 5_000 }),
    ...overrides,
  });
  return { executor, journal };
}

function opsMandate(allowActuate = true, issuer = ISSUER.privateKey) {
  return issueOperationsMandate({ missionId: 'misiune-ops-001', objective: OBJECTIVE, hostId: HOST, allowActuate, ttlMinutes: 30 }, issuer);
}

function hashFor(mandateId: string, device: string, command: string) {
  return actionHash({ host_id: HOST, mandate_id: mandateId, type: 'ops.actuate', args: { device, command }, resource: `unit:ronor-${device}.service` });
}

function approve(
  mandateId: string,
  device: string,
  command: string,
  overrides: { ttlMs?: number; now?: Date; key?: crypto.KeyObject; origin?: RequestOrigin } = {},
) {
  return signActuationApproval(
    { mandateId, actionHash: hashFor(mandateId, device, command), ttlMs: overrides.ttlMs ?? 300_000, now: overrides.now, origin: overrides.origin },
    overrides.key ?? APPROVER.privateKey,
  );
}

function actuate(mandate: ReturnType<typeof opsMandate>, device: string, command: string, approval: unknown) {
  return { mandate, objective: OBJECTIVE, owner: 'operator-1', action: { type: 'ops.actuate', args: { device, command } }, approval };
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('condiția nu s-a îndeplinit la timp');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('unitatea fictivă imită systemd: clientul nu e efectul', () => {
  it('uciderea clientului `systemctl start` nu oprește unitatea; efectul final apare (defectul D1 reprodus)', async () => {
    const client = spawn(sd.systemctl, ['start', '--', 'ronor-lent.service'], { detached: true, stdio: 'ignore' });
    await waitFor(() => sd.markers().some((m) => m.startsWith('inceput ronor-lent.service')));
    const unitPid = sd.unitPid('ronor-lent.service');
    expect(unitPid).not.toBeNull();
    expect(sd.processGroup(unitPid!)).not.toBe(client.pid);
    process.kill(-client.pid!, 'SIGKILL');
    await waitFor(() => sd.markers().some((m) => m.startsWith('final ronor-lent.service')), 6_000);
    // Ca în systemd, efectul (marcajul final) precede trecerea unității în `inactive`.
    // Starea se citește după ce unitatea a ieșit din `activating`, nu în intervalul
    // dintre cele două scrieri (cursă observată pe main la 1db662a, rularea 36177971192).
    await waitFor(() => sd.state('ronor-lent.service').activeState !== 'activating', 6_000);
    expect(sd.state('ronor-lent.service')).toEqual({ activeState: 'inactive', subState: 'dead' });
  });
});

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

  it('primește numai chei publice pentru mandat și aprobare, o cheie privată proprie pentru chitanțe, fără suprapuneri (D3)', () => {
    const privateRing = new Map([[keyId(APPROVER.privateKey), APPROVER.privateKey]]);
    expect(() => build({ approvalKeys: privateRing })).toThrow('executor_approval_keys_must_be_public_ed25519');
    expect(() => build({ approvalKeys: new Map() })).toThrow('executor_approval_keys_missing');
    expect(() => build({ receiptKey: EXECUTOR.publicKey })).toThrow('executor_receipt_key_must_be_private_ed25519');
    expect(() => build({ approvalKeys: keyringFrom([EXECUTOR.publicKey]) })).toThrow('executor_keys_must_be_distinct');
    expect(() => build({ approvalKeys: MANDATE_KEYS })).toThrow('executor_keys_must_be_distinct');
    const pem = (k: crypto.KeyObject) => k.export({ type: k.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }).toString();
    expect(() => parsePublicKeyring(pem(APPROVER.privateKey), 'approval')).toThrow('approval_keyring_contains_private_key');
    const ring = parsePublicKeyring(pem(APPROVER.publicKey) + pem(ISSUER.publicKey), 'approval');
    expect([...ring.keys()].sort()).toEqual([keyId(APPROVER.publicKey), keyId(ISSUER.publicKey)].sort());
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

describe('semnături asimetrice: executorul nu poate emite mandate și nu poate aproba (D3)', () => {
  it('mandatul de operațiuni e v2, semnat Ed25519 de emitent; o cheie din afara inelului sau un câmp schimbat îl invalidează', async () => {
    const mandate = opsMandate();
    expect(mandate.authority_version).toBe('ronor-ops-mandate/v2');
    expect(mandate.issued_by_key_id).toBe(keyId(ISSUER.publicKey));
    expect(verifyOperationsMandate(mandate, MANDATE_KEYS)).toBe(true);
    expect(verifyOperationsMandate({ ...mandate, allowed_actions: [...mandate.allowed_actions, 'deploy'] }, MANDATE_KEYS)).toBe(false);
    // Executorul, cu cheia lui privată de chitanțe, produce un mandat pe care propriul inel îl refuză.
    const selfIssued = opsMandate(true, EXECUTOR.privateKey);
    expect(verifyOperationsMandate(selfIssued, MANDATE_KEYS)).toBe(false);
    const { executor, journal } = build();
    const approval = approve(selfIssued.mandate_id, 'runtime', 'restart');
    expect(await executor.execute(actuate(selfIssued, 'runtime', 'restart', approval))).toEqual({ state: 'refused', reason: 'mandate_authority_invalid' });
    // Un mandat v1 (HMAC al runtime-ului de dezvoltare) nu e acceptat de executor.
    const v1 = signMandateAuthority({ ...mandate, authority_version: undefined, authority_signature: undefined }, 'proba-dezvoltare-'.padEnd(48, '0'));
    expect(await executor.execute(actuate(v1, 'runtime', 'restart', approval))).toEqual({ state: 'refused', reason: 'mandate_authority_invalid' });
    expect(sd.calls()).toEqual([]);
    journal.close();
  });

  it('cu cheile pe care le deține, executorul nu poate produce o aprobare validă', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    // Cu o cheie publică nu se poate semna deloc.
    expect(() => signActuationApproval({ mandateId: mandate.mandate_id, actionHash: hashFor(mandate.mandate_id, 'runtime', 'restart'), ttlMs: 60_000 }, APPROVER.publicKey)).toThrow(
      'approval_signing_requires_private_key',
    );
    // Cu singura cheie privată a executorului (chitanțele): aprobatorul e necunoscut.
    const selfApproved = approve(mandate.mandate_id, 'runtime', 'restart', { key: EXECUTOR.privateKey });
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', selfApproved))).toEqual({ state: 'refused', reason: 'approval_approver_unknown' });
    // Declarându-se aprobatorul, semnătura nu se verifică.
    const impersonated = { ...selfApproved, approver_key_id: keyId(APPROVER.publicKey) };
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', impersonated))).toEqual({ state: 'refused', reason: 'approval_signature_invalid' });
    expect(sd.calls()).toEqual([]);
    journal.close();
  });
});

describe('observare și actuare', () => {
  it('observă din lista albă și semnează rezultatul cu cheia executorului; nu actuează cu mandat numai de observare', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate(false);
    const outcome = await executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', action: { type: 'ops.observe', args: { target: 'runtime' } } });
    expect(outcome.state).toBe('done');
    if (outcome.state === 'refused') throw new Error('refuzat');
    expect(outcome.output).toContain('ActiveState=inactive');
    const record = journal.get(outcome.executionId)!;
    const body = { execution_id: record.execution_id, host_id: HOST, mandate_id: mandate.mandate_id, action_hash: record.action_hash, state: 'done' as const, exit_code: 0, output_sha256: record.output_sha256!, finished_at: record.finished_at! };
    expect(verifyExecutionReceipt(body, outcome.receipt, EXECUTOR.publicKey)).toBe(true);
    expect(verifyExecutionReceipt({ ...body, exit_code: 1 }, outcome.receipt, EXECUTOR.publicKey)).toBe(false);
    expect(verifyExecutionReceipt(body, outcome.receipt, APPROVER.publicKey)).toBe(false);
    const refused = await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')));
    expect(refused).toEqual({ state: 'refused', reason: 'action_not_allowed:ops.actuate' });
    expect(sd.calls().filter((c) => c.includes('restart'))).toEqual([]);
    journal.close();
  });

  it('refuză ținte, verbe și argumente din afara listei albe, înainte de orice proces', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const run = (args: Record<string, unknown>, type = 'ops.actuate') =>
      executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', action: { type, args }, approval: approve(mandate.mandate_id, 'runtime', 'restart') });
    expect(await run({ device: 'docker', command: 'restart' })).toEqual({ state: 'refused', reason: 'device_not_in_allowlist' });
    expect(await run({ device: 'runtime', command: 'stop' })).toEqual({ state: 'refused', reason: 'command_not_in_allowlist' });
    expect(await run({ device: 'runtime', command: 'restart; rm -rf /' })).toEqual({ state: 'refused', reason: 'invalid_args' });
    expect(await run({ device: 'runtime', command: 'restart', extra: 'x' })).toEqual({ state: 'refused', reason: 'unknown_arg:extra' });
    expect(await run({ target: 'necunoscut' }, 'ops.observe')).toEqual({ state: 'refused', reason: 'target_not_in_allowlist' });
    expect(sd.calls()).toEqual([]);
    journal.close();
  });

  it('refuză un mandat nesemnat de emitent sau revocat', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const forged = opsMandate(true, pair().privateKey);
    expect(await executor.execute(actuate(forged, 'runtime', 'restart', approve(forged.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'mandate_authority_invalid' });
    executor.revokeMandate(mandate.mandate_id, 'probă');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'mandate_revoked' });
    expect(sd.calls()).toEqual([]);
    journal.close();
  });
});

describe('proveniența e în conținutul semnat al aprobării (D4, F04)', () => {
  it('cererea nu mai poate declara `origin`, nici pentru actuare, nici pentru observare', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const approval = approve(mandate.mandate_id, 'runtime', 'restart');
    for (const origin of ['operator', 'memory', 'model']) {
      expect(await executor.execute({ ...actuate(mandate, 'runtime', 'restart', approval), origin } as never)).toEqual({ state: 'refused', reason: 'request_origin_field_forbidden' });
      expect(
        await executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', origin, action: { type: 'ops.observe', args: { target: 'runtime' } } } as never),
      ).toEqual({ state: 'refused', reason: 'request_origin_field_forbidden' });
    }
    expect(sd.calls()).toEqual([]);
    // Aprobarea nu a fost atinsă: aceeași cerere, fără câmpul `origin`, trece.
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval))).toMatchObject({ state: 'done' });
    journal.close();
  });

  it('o aprobare semnată cu proveniența `memory` sau `model` e refuzată și arsă; schimbarea provenienței invalidează semnătura', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    for (const origin of ['memory', 'model', 'external'] as const) {
      const approval = approve(mandate.mandate_id, 'runtime', 'restart', { origin });
      expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approval))).toEqual({ state: 'refused', reason: `origin_not_authoritative:${origin}` });
      expect(journal.isRevoked('approval', approval.approval_id)).toBe(true);
      const relabeled = { ...approval, origin: 'operator' };
      expect(await executor.execute(actuate(mandate, 'runtime', 'restart', relabeled))).toEqual({ state: 'refused', reason: 'approval_signature_invalid' });
    }
    // Și invers: o aprobare `operator` cu proveniența schimbată nu mai e validă.
    const good = approve(mandate.mandate_id, 'runtime', 'restart');
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', { ...good, origin: 'memory' }))).toEqual({ state: 'refused', reason: 'approval_signature_invalid' });
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', { ...good, origin: undefined }))).toEqual({ state: 'refused', reason: 'approval_malformed' });
    expect(sd.calls()).toEqual([]);
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
    expect(await reason(approve(mandate.mandate_id, 'lent', 'restart', { key: pair().privateKey }))).toBe('approval_approver_unknown');
    const tampered = { ...approve(mandate.mandate_id, 'lent', 'restart'), expires_at: new Date(Date.now() + 60 * 60_000).toISOString() };
    expect(await reason(tampered)).toBe('approval_signature_invalid');
    expect(await reason(approve(mandate.mandate_id, 'lent', 'restart', { ttlMs: 60_000, now: new Date(Date.now() - 120_000) }))).toBe('approval_expired');
    expect(() => approve(mandate.mandate_id, 'lent', 'restart', { ttlMs: MAX_APPROVAL_TTL_MS + 1 })).toThrow('approval_ttl_outside_policy');
    expect(sd.calls()).toEqual([]);
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
    expect(sd.calls().filter((c) => c.startsWith('apel restart'))).toHaveLength(1);
    expect(sd.markers().filter((m) => m.startsWith('final ronor-runtime.service'))).toHaveLength(1);
    journal.close();
  });

  it('un eșec de actuare rămâne vizibil după o observare reușită (fără indicator global, F09)', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const failed = await executor.execute(actuate(mandate, 'cade', 'restart', approve(mandate.mandate_id, 'cade', 'restart')));
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 });
    expect((failed as { receipt: string | null }).receipt).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await executor.execute({ mandate, objective: OBJECTIVE, owner: 'operator-1', action: { type: 'ops.observe', args: { target: 'runtime' } } });
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
    expect(sd.calls()).toEqual([]);
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
    expect(sd.calls()).toEqual([]);
    journal.close();
  });

  async function startSlow(executor: MandatedExecutor, mandate: ReturnType<typeof opsMandate>, device = 'lent', command = 'restart', nth = 1) {
    const pending = executor.execute(actuate(mandate, device, command, approve(mandate.mandate_id, device, command)));
    await waitFor(() => sd.markers().filter((m) => m.startsWith(`inceput ronor-${device}.service`)).length >= nth);
    // Obiect, nu promisiune: `await` pe funcția asincronă nu trebuie să aștepte sfârșitul execuției.
    return { pending };
  }

  it('D1: STOP în timpul acțiunii lente oprește unitatea însăși; `interrupted` numai după confirmarea `inactive`, iar efectul final lipsește', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate);
    const unitPid = sd.unitPid('ronor-lent.service')!;
    expect(sd.alive(unitPid)).toBe(true);
    executor.stop('probă STOP în curs');
    const outcome = (await pending) as Extract<ExecutionOutcome, { executionId: string }>;
    expect(outcome.state).toBe('interrupted');
    expect(outcome.reason).toBe('stop_active:probă STOP în curs;unit=inactive/dead');
    expect(outcome.receipt).toBeNull();
    expect(journal.get(outcome.executionId)?.state).toBe('interrupted');
    // Oprirea a trecut prin unitate, nu doar prin client.
    expect(sd.calls()).toEqual(expect.arrayContaining([expect.stringMatching(/^apel stop -- ronor-lent\.service$/)]));
    expect(sd.calls()).toEqual(expect.arrayContaining([expect.stringMatching(/^apel show --property=ActiveState,SubState -- ronor-lent\.service$/)]));
    expect(sd.alive(unitPid)).toBe(false);
    // Efectul: după ce ar fi trecut întârzierea unității, marcajul final lipsește.
    await sleep(2_500);
    expect(sd.markers().some((m) => m.startsWith('final ronor-lent.service'))).toBe(false);
    expect(sd.state('ronor-lent.service').activeState).toBe('inactive');
    expect(journal.leaseHolder('unit:ronor-lent.service', new Date())).toBeNull();
    journal.close();
  });

  it('D1: dacă oprirea unității nu se confirmă, starea e `interrupt_unconfirmed`, nu `interrupted`, și nu are chitanță', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate, 'tenace', 'start');
    executor.stop('probă STOP tenace');
    const outcome = (await pending) as Extract<ExecutionOutcome, { executionId: string }>;
    expect(outcome.state).toBe('interrupt_unconfirmed');
    expect(outcome.reason).toBe('stop_active:probă STOP tenace;unit=activating/start');
    expect(outcome.receipt).toBeNull();
    expect(journal.get(outcome.executionId)?.state).toBe('interrupt_unconfirmed');
    // Au fost încercate ambele forme din lista albă: stop, apoi kill.
    expect(sd.calls().filter((c) => /^apel (stop|kill)/.test(c))).toEqual(['apel stop -- ronor-tenace.service', 'apel kill --signal=SIGKILL -- ronor-tenace.service']);
    expect(journal.leaseHolder('unit:ronor-tenace.service', new Date())).toBeNull();
    journal.close();
  });

  it('STOP dat din alt proces (alt executor pe același jurnal) sau prin fișier oprește acțiunea în curs, cu efectul oprit', async () => {
    const stopFile = path.join(dir, 'STOP');
    const { executor, journal } = build({ stopFile });
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate);
    const other = build();
    other.executor.stop('din consolă');
    other.journal.close();
    expect(await pending).toMatchObject({ state: 'interrupted', reason: 'stop_active:din consolă;unit=inactive/dead' });

    executor.clearStop('operator-1');
    const again = await startSlow(executor, mandate, 'lent', 'restart', 2);
    fs.writeFileSync(stopFile, '');
    expect(await again.pending).toMatchObject({ state: 'interrupted', reason: 'stop_active:fișier;unit=inactive/dead' });
    await sleep(2_500);
    expect(sd.markers().some((m) => m.startsWith('final ronor-lent.service'))).toBe(false);
    journal.close();
  });

  it('revocarea mandatului oprește acțiunea în curs și unitatea', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const { pending } = await startSlow(executor, mandate);
    executor.revokeMandate(mandate.mandate_id, 'probă');
    expect(await pending).toMatchObject({ state: 'interrupted', reason: 'mandate_revoked_during_execution;unit=inactive/dead' });
    expect(sd.state('ronor-lent.service').activeState).toBe('inactive');
    journal.close();
  });
});

describe('starea unității înainte de actuare (D2)', () => {
  it.each(['activating', 'deactivating', 'reloading'])('refuză actuarea peste o unitate în `%s`, fără să atingă unitatea și fără să consume aprobarea', async (state) => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    sd.setState('ronor-lent.service', state, 'start');
    const approval = approve(mandate.mandate_id, 'lent', 'start');
    expect(await executor.execute(actuate(mandate, 'lent', 'start', approval))).toEqual({ state: 'refused', reason: `unit_in_transition:${state}` });
    expect(sd.calls()).toEqual(['apel show --property=ActiveState,SubState -- ronor-lent.service']);
    expect(journal.findByApproval(approval.approval_id)).toBeNull();
    expect(journal.leaseHolder('unit:ronor-lent.service', new Date())).toBeNull();
    sd.setState('ronor-lent.service', 'inactive', 'dead');
    expect(await executor.execute(actuate(mandate, 'lent', 'start', approval))).toMatchObject({ state: 'done' });
    journal.close();
  });

  it('după un STOP neconfirmat și ridicarea STOP-ului, o aprobare nouă nu se alipește jobului rămas în curs (proba 6-bis)', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const pending = executor.execute(actuate(mandate, 'tenace', 'start', approve(mandate.mandate_id, 'tenace', 'start')));
    await waitFor(() => sd.markers().some((m) => m.startsWith('inceput ronor-tenace.service')));
    executor.stop('probă');
    expect(await pending).toMatchObject({ state: 'interrupt_unconfirmed' });
    executor.clearStop('operator-1');
    const second = await executor.execute(actuate(mandate, 'tenace', 'start', approve(mandate.mandate_id, 'tenace', 'start')));
    expect(second).toEqual({ state: 'refused', reason: 'unit_in_transition:activating' });
    expect(sd.calls().filter((c) => c.startsWith('apel start'))).toHaveLength(1);
    journal.close();
  });

  it('refuză actuarea dacă starea unității nu poate fi citită', async () => {
    const { executor, journal } = build({ unitState: async () => ({ ok: false, reason: 'unit_state_unavailable:1' }) });
    const mandate = opsMandate();
    expect(await executor.execute(actuate(mandate, 'runtime', 'restart', approve(mandate.mandate_id, 'runtime', 'restart')))).toEqual({ state: 'refused', reason: 'unit_state_unavailable:1' });
    expect(sd.calls()).toEqual([]);
    journal.close();
  });
});

describe('contradicție, lease și repornire', () => {
  it('o a doua actuare pe aceeași unitate, cât prima e în curs, e refuzată indiferent de deținător', async () => {
    const { executor, journal } = build();
    const mandate = opsMandate();
    const pending = executor.execute(actuate(mandate, 'lent', 'restart', approve(mandate.mandate_id, 'lent', 'restart')));
    await waitFor(() => sd.markers().length === 1);
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

  it('după o repornire, o actuare rămasă „started” devine interrupt_unconfirmed (efect neconfirmat) și nu se reia', () => {
    const file = path.join(dir, 'restart.db');
    const journal = new ExecutorJournal(file);
    journal.admit({ execution_id: 'exec_1', idempotency_key: 'approval:appr_1', mandate_id: 'm', action_type: 'ops.actuate', target: 'unit:x', command: 'restart', action_hash: 'h', approval_id: 'appr_1', owner: 'o', created_at: new Date().toISOString() });
    journal.markStarted('exec_1', new Date());
    const concurrent = new ExecutorJournal(file);
    expect(concurrent.get('exec_1')?.state).toBe('started');
    concurrent.close();
    journal.close();
    const raw = new Database(file);
    raw.prepare('UPDATE executions SET pid = ? WHERE execution_id = ?').run(2147483646, 'exec_1');
    raw.close();
    const reopened = new ExecutorJournal(file);
    expect(reopened.get('exec_1')).toMatchObject({ state: 'interrupt_unconfirmed', reason: 'process_restart_outcome_unknown' });
    expect(() => reopened.finish('exec_1', { state: 'done', reason: null, exitCode: 0, outputSha256: null, receipt: null, at: new Date() })).toThrow('executor_journal_transition_refused:done');
    reopened.close();
  });

  it('un jurnal creat înainte de `interrupt_unconfirmed` e migrat, cu înregistrările păstrate', () => {
    const file = path.join(dir, 'vechi.db');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, mandate_id TEXT NOT NULL, action_type TEXT NOT NULL,
        target TEXT NOT NULL, command TEXT, action_hash TEXT NOT NULL, approval_id TEXT UNIQUE, owner TEXT NOT NULL, pid INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('admitted','started','done','failed','interrupted')), reason TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, exit_code INTEGER, output_sha256 TEXT, receipt TEXT)`);
    raw.prepare(`INSERT INTO executions (execution_id, idempotency_key, mandate_id, action_type, target, action_hash, approval_id, owner, pid, state, created_at)
      VALUES ('exec_v', 'approval:appr_v', 'm', 'ops.actuate', 'unit:x', 'h', 'appr_v', 'o', 1, 'interrupted', '2026-09-25T00:00:00.000Z')`).run();
    raw.close();
    const journal = new ExecutorJournal(file);
    expect(journal.get('exec_v')).toMatchObject({ state: 'interrupted', approval_id: 'appr_v' });
    journal.admit({ execution_id: 'exec_n', idempotency_key: 'approval:appr_n', mandate_id: 'm', action_type: 'ops.actuate', target: 'unit:x', command: 'start', action_hash: 'h', approval_id: 'appr_n', owner: 'o', created_at: new Date().toISOString() });
    journal.finish('exec_n', { state: 'interrupt_unconfirmed', reason: 'probă', exitCode: null, outputSha256: null, receipt: null, at: new Date() });
    expect(journal.get('exec_n')?.state).toBe('interrupt_unconfirmed');
    expect(() => journal.admit({ execution_id: 'exec_d', idempotency_key: 'approval:appr_v', mandate_id: 'm', action_type: 'ops.actuate', target: 'unit:x', command: 'start', action_hash: 'h', approval_id: 'appr_x', owner: 'o', created_at: new Date().toISOString() })).toThrow(/UNIQUE/);
    journal.close();
  });
});

describe('bucla operatorului: aprobarea legată de hash', () => {
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

  it('booleanul approved nu mai autorizează; trece numai aprobarea Ed25519 pentru acțiunea exactă, cu proveniența operator', () => {
    // max_cost_usd al mandatului de operațiuni e 0: bucla îl tratează drept buget epuizat.
    const funded = { ...opsMandate(), max_cost_usd: 1 };
    expect(tick(funded, { approved: true })).toEqual({ decision: 'blocked', reason: 'approval_required' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart') })).toEqual({ decision: 'blocked', reason: 'approval_verifier_unavailable' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart'), approvalKeys: APPROVAL_KEYS, hostId: HOST })).toEqual({ decision: 'ready_to_execute', reason: 'operator_tick_permitted' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'lent', 'restart'), approvalKeys: APPROVAL_KEYS, hostId: HOST })).toEqual({ decision: 'blocked', reason: 'approval_action_mismatch' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart'), approvalKeys: APPROVAL_KEYS, hostId: 'alta-gazda' })).toEqual({ decision: 'blocked', reason: 'approval_action_mismatch' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart', { origin: 'model' }), approvalKeys: APPROVAL_KEYS, hostId: HOST })).toEqual({ decision: 'blocked', reason: 'origin_not_authoritative:model' });
    expect(tick(funded, { approval: approve(funded.mandate_id, 'runtime', 'restart', { key: EXECUTOR.privateKey }), approvalKeys: APPROVAL_KEYS, hostId: HOST })).toEqual({ decision: 'blocked', reason: 'approval_approver_unknown' });
    expect(verifyActuationApproval(approve(funded.mandate_id, 'runtime', 'restart'), { mandateId: funded.mandate_id, actionHash: hashFor(funded.mandate_id, 'runtime', 'restart'), now: new Date() }, APPROVAL_KEYS)).toEqual({ ok: true });
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
