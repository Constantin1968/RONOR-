/**
 * CLI-ul executorului (D6): `issue-mandate` există, iar `action-hash` și
 * `approve` nu deschid jurnalul și nu citesc cheile executorului. Comenzile
 * executorului nu mai au `approve` pe calea lor, iar fără cheia privată a
 * omului nu se poate aproba.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const CLI = path.join(__dirname, '../../src/runtime/executor/cli.ts');
let dir: string;

function run(args: string[], env: Record<string, string>, input = '') {
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    cwd: path.join(__dirname, '../..'),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-executor-cli-'));
  fs.writeFileSync(
    path.join(dir, 'catalog.json'),
    JSON.stringify({
      host_id: 'gazda-cli',
      systemctl: ['/usr/bin/sudo', '-n', '/usr/bin/systemctl'],
      entries: [{ id: 'efect', type: 'ops.actuate', kind: 'systemd', unit: 'ronor-efect.service', commands: ['start'], timeout_ms: 5_000 }],
    }),
  );
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it('keygen, issue-mandate, action-hash și approve lucrează fără jurnal și fără cheile executorului', () => {
  const p = (name: string) => path.join(dir, name);
  const issuer = run(['keygen', p('emitent.key'), p('emitent.pub')], {});
  expect(issuer.code).toBe(0);
  expect(JSON.parse(issuer.stdout).key_id).toMatch(/^key_[a-f0-9]{12}$/);
  expect(issuer.stdout).not.toContain('PRIVATE');
  expect(fs.statSync(p('emitent.key')).mode & 0o777).toBe(0o600);
  expect(run(['keygen', p('emitent.key'), p('alt.pub')], {}).code).not.toBe(0);
  expect(run(['keygen', p('aprobator.key'), p('aprobator.pub')], {}).code).toBe(0);

  const catalog = { RONOR_EXECUTOR_CATALOG: p('catalog.json') };
  const mandateOut = run(['issue-mandate', 'misiune-cli', '30', 'actuate'], { ...catalog, RONOR_MANDATE_ISSUER_KEY_FILE: p('emitent.key') }, 'obiectiv de probă');
  expect(mandateOut.code).toBe(0);
  const mandate = JSON.parse(mandateOut.stdout);
  expect(mandate).toMatchObject({ authority_version: 'ronor-ops-mandate/v2', workspace_root: 'ops://gazda-cli', issued_by_key_id: JSON.parse(issuer.stdout).key_id });
  expect(mandate.allowed_actions).toEqual(['ops_observe', 'ops_actuate']);

  const request = JSON.stringify({ mandate, objective: 'obiectiv de probă', owner: 'operator-1', action: { type: 'ops.actuate', args: { device: 'efect', command: 'start' } } });
  const hash = run(['action-hash'], catalog, request);
  expect(hash.code).toBe(0);
  expect(JSON.parse(hash.stdout).action_hash).toMatch(/^[a-f0-9]{64}$/);

  const approval = run(['approve', '300'], { ...catalog, RONOR_APPROVER_KEY_FILE: p('aprobator.key') }, request);
  expect(approval.code).toBe(0);
  expect(JSON.parse(approval.stdout)).toMatchObject({ version: 'ronor-actuation-approval/v2', origin: 'operator', action_hash: JSON.parse(hash.stdout).action_hash });

  // Fără cheia privată a omului nu există aprobare.
  const noKey = run(['approve', '300'], catalog, request);
  expect(noKey.code).toBe(70);
  expect(noKey.stderr).toContain('missing_env:RONOR_APPROVER_KEY_FILE');
  // Nicio comandă a omului nu a creat un jurnal.
  expect(fs.readdirSync(dir).filter((f) => f.endsWith('.db') || f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([]);
});

it('comenzile executorului refuză un inel de chei publice care conține o cheie privată', () => {
  const p = (name: string) => path.join(dir, name);
  const out = run(['status'], {
    RONOR_EXECUTOR_CATALOG: p('catalog.json'),
    RONOR_EXECUTOR_DB: p('jurnal.db'),
    RONOR_EXECUTOR_MANDATE_PUBKEYS_FILE: p('emitent.pub'),
    RONOR_EXECUTOR_APPROVER_PUBKEYS_FILE: p('aprobator.key'),
    RONOR_EXECUTOR_RECEIPT_KEY_FILE: p('emitent.key'),
  });
  expect(out.code).toBe(70);
  expect(out.stderr).toContain('approval_keyring_contains_private_key');
  expect(fs.existsSync(p('jurnal.db'))).toBe(false);
});
