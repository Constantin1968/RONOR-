import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main, controllerUrl, usageText, failureLine, ControllerRefusal, COMMANDS, EXPLANATIONS } from '../../scripts/ronor-develop.mjs';

test('no arguments and help print the command list without touching a credential or the network', async () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    // An empty environment proves help reads no credential file and opens no socket.
    const result = await main(args, {});
    assert.ok(Array.isArray(result.usage));
    const text = result.usage.join('\n');
    for (const command of Object.keys(COMMANDS)) assert.ok(text.includes(command), `${command} lipsește din text`);
    assert.ok(text.includes('RONOR_DEVELOPMENT_API_KEY_FILE'));
  }
  assert.equal(usageText().join('\n').includes('verify-existing'), true);
  await assert.rejects(main(['nu-exista'], {}), /invalid_command/);
});

test('every dispatched command is documented and every refusal code is explained in Romanian', () => {
  // Drift between the documented list and the dispatch would silently hide a command.
  const dispatched = ['start', 'status', 'cancel', 'readiness', 'verify-existing',
    'verification-status', 'verification-cancel'];
  assert.deepEqual(Object.keys(COMMANDS).sort(), [...dispatched].sort());
  for (const [code, text] of Object.entries(EXPLANATIONS)) {
    assert.match(code, /^[a-z][a-z0-9_]{2,60}$/);
    assert.ok(text.length > 12 && text.endsWith('.'), `${code} nu are o explicație completă`);
  }
});

test('every refusal code the server can return is explained by the CLI', () => {
  // Drift guard: a new refusal code added to the runtime without an explanation
  // here would degrade to the generic failure line and hide the real cause.
  const sources = ['src/runtime/automation/existing-commit-verification.ts',
    'src/runtime/automation/existing-commit-workspace.ts',
    'src/runtime/automation/development-controller.ts']
    .map(file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')).join('\n');
  const codes = new Set();
  for (const match of sources.matchAll(/(?:refusal\(|new Error\(|error: ?)'([a-z][a-z0-9_]{2,60})'/g)) {
    codes.add(match[1]);
  }
  assert.ok(codes.size > 15, `prea puține coduri extrase: ${codes.size}`);
  const missing = [...codes].filter(code => !(code in EXPLANATIONS));
  assert.deepEqual(missing, [], `coduri fără explicație: ${missing.join(', ')}`);
});

test('a refusal is named and explained, and an unknown message never reaches the operator', () => {
  const refusal = failureLine(new ControllerRefusal('verification_head_mismatch', 409));
  assert.ok(refusal.includes('verification_head_mismatch') && refusal.includes('HTTP 409'));
  assert.ok(refusal.includes(EXPLANATIONS.verification_head_mismatch));
  assert.ok(failureLine(new Error('request_contract_refused')).includes('contractul'));
  assert.ok(failureLine(new Error('controller_http_503')).includes('starea 503'));
  const secret = 'Bearer 0123456789abcdef0123456789abcdef /run/secrets/development_architect_key';
  const leaked = failureLine(new Error(secret));
  assert.equal(leaked.includes('Bearer'), false);
  assert.equal(leaked.includes('/run/secrets'), false);
  assert.ok(leaked.startsWith('Comanda nu a reușit.'));
  assert.ok(failureLine(new ControllerRefusal(secret, 500)).startsWith('Comanda nu a reușit.'));
});

test('controller URL cannot disclose credentials to a remote or credential-bearing URL', () => {
  assert.equal(controllerUrl(), 'http://127.0.0.1:3010');
  for (const url of ['https://example.com', 'http://10.0.0.1', 'http://127.0.0.1/path',
    'http://operator:password@127.0.0.1', 'http://127.0.0.1?token=x']) {
    assert.throws(() => controllerUrl(url));
  }
});

test('CLI follows readiness → persistent job → bounded execution → status → cancel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-cli-test-'));
  const credential = path.join(root, 'key');
  const requestFile = path.join(root, 'request.json');
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(credential, key, { mode: 0o600 });
  fs.writeFileSync(requestFile, JSON.stringify({
    objective: 'Test-only pipeline contract', max_cost_usd: 1,
    max_runtime_minutes: 5, max_fix_cycles: 1,
  }));
  const seen = [];
  let ready = true; let redirect = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ url: req.url, method: req.method, body, id: req.headers['idempotency-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (redirect) {
      res.writeHead(302, { location: 'http://127.0.0.1:1/never-contact' }); res.end(); return;
    }
    if (req.url.endsWith('/readiness')) res.end(JSON.stringify({ ok: true, automation: { ready } }));
    else if (req.url === '/api/development/jobs') res.end(JSON.stringify({ ok: true, job: { job_id: 'dev_test', mission_id: 'msn_test' } }));
    else if (req.url.endsWith('/run')) res.end(JSON.stringify({ ok: true, run: { run_id: 'run_test', status: 'queued' } }));
    else if (req.url.endsWith('/cancel')) res.end(JSON.stringify({ ok: true, status: 'cancellation_requested', rollback: false }));
    else res.end(JSON.stringify({ ok: true, run: { status: 'executing' }, fabric_run: { stage: 'openhands' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { RONOR_DEVELOPMENT_URL: `http://127.0.0.1:${server.address().port}`, RONOR_DEVELOPMENT_API_KEY_FILE: credential };
  try {
    const start = ['start', `--request=${requestFile}`, '--id=contract-test-1'];
    const result = await main(start, env);
    assert.deepEqual(result, { job_id: 'dev_test', mission_id: 'msn_test', run_id: 'run_test', status: 'queued' });
    assert.equal(seen.length, 3);
    assert.equal(seen[1].id, 'contract-test-1'); assert.equal(seen[2].id, 'contract-test-1');
    assert.equal(seen[2].body.approved, true); assert.equal(seen[2].body.max_cost_usd, 1);
    assert.equal('objective' in seen[2].body, false);
    assert.equal((await main(['status', '--mission=msn_test', '--run=run_test'], env)).progress.stage, 'openhands');
    assert.equal((await main(['cancel', '--mission=msn_test', '--run=run_test'], env)).rollback, false);
    ready = false;
    const before = seen.length;
    await assert.rejects(main(start, env), /automation_not_ready/);
    assert.equal(seen.length, before + 1, 'no intent or execution is submitted when readiness is false');
    redirect = true;
    await assert.rejects(main(['readiness'], env));
    redirect = false;
    fs.chmodSync(credential, 0o644);
    const beforePermissions = seen.length;
    await assert.rejects(main(['readiness'], env), /credential_file_permissions_refused/);
    assert.equal(seen.length, beforePermissions);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MOCK controller: a policy refusal is carried through with its code, and a refusal reason is explained', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-cli-refusal-test-'));
  const credential = path.join(root, 'key');
  fs.writeFileSync(credential, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const specFile = path.join(root, 'verification.json');
  fs.writeFileSync(specFile, JSON.stringify({ base_commit: 'a'.repeat(40),
    head_commit: 'b'.repeat(40), max_cost_usd: 1, max_runtime_minutes: 5 }));
  const id = `verify_${'d'.repeat(64)}`;
  let mode = 'policy';
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/development/verify-existing' && mode === 'policy') {
      res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'verification_workspace_busy' })); return;
    }
    if (req.url === '/api/development/verify-existing' && mode === 'hostile') {
      // A controller that tries to push arbitrary text must be ignored.
      res.writeHead(422); res.end(JSON.stringify({ ok: false, error: 'Bearer deadbeef /run/secrets/key' })); return;
    }
    res.end(JSON.stringify({ ok: true, verification: { verification_id: id,
      status: 'failed', reason: 'verification_workspace_refused' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { RONOR_DEVELOPMENT_URL: `http://127.0.0.1:${server.address().port}`,
    RONOR_DEVELOPMENT_API_KEY_FILE: credential };
  try {
    const start = ['verify-existing', '--id=refusal-cli-001', `--request=${specFile}`];
    await assert.rejects(main(start, env), error => {
      assert.ok(error instanceof ControllerRefusal);
      assert.equal(error.code, 'verification_workspace_busy');
      assert.equal(error.httpStatus, 409);
      assert.ok(failureLine(error).includes(EXPLANATIONS.verification_workspace_busy));
      return true;
    });
    mode = 'hostile';
    await assert.rejects(main(start, env), error => {
      assert.equal(error instanceof ControllerRefusal, false);
      assert.equal(error.message, 'controller_http_422');
      return true;
    });
    mode = 'status';
    const status = await main(['verification-status', `--verification=${id}`], env);
    assert.equal(status.verification.reason, 'verification_workspace_refused');
    assert.equal(status.reason_explained, EXPLANATIONS.verification_workspace_refused);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MOCK controller: verify-existing is a distinct pinned operation without author/planner readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-cli-existing-test-'));
  const credential = path.join(root, 'key'); const specFile = path.join(root, 'verification.json');
  fs.writeFileSync(credential, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const spec = { base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40),
    max_cost_usd: 1, max_runtime_minutes: 5 };
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const seen = []; const id = `verify_${'c'.repeat(64)}`;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ route: req.url, method: req.method, body, id: req.headers['idempotency-key'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, verification: {
      verification_id: id, operation: 'verify-existing', full_development: false,
      status: req.url.endsWith('/cancel') ? 'cancelled' : 'queued',
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { RONOR_DEVELOPMENT_URL: `http://127.0.0.1:${server.address().port}`, RONOR_DEVELOPMENT_API_KEY_FILE: credential };
  try {
    const start = ['verify-existing', '--id=existing-cli-001', `--request=${specFile}`];
    const result = await main(start, env);
    assert.equal(result.verification.operation, 'verify-existing');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { route: '/api/development/verify-existing', method: 'POST',
      body: { approved: true, ...spec }, id: 'existing-cli-001' });
    await main(['verification-status', `--verification=${id}`], env);
    assert.equal((await main(['verification-cancel', `--verification=${id}`], env)).rollback, false);
    assert.equal(seen.length, 3);
    assert.ok(seen.every(s => !s.route.includes('/runtime/')));
    for (const bad of [{ ...spec, head_commit: 'HEAD' }, { ...spec, workspace_root: '/not-admitted' },
      { ...spec, command: 'node' }, { ...spec, max_cost_usd: 6 }, { ...spec, base_commit: spec.head_commit }]) {
      fs.writeFileSync(specFile, JSON.stringify(bad));
      await assert.rejects(main(start, env), /request_contract_refused/);
    }
    assert.equal(seen.length, 3);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    // Leave the clearly labelled offline fixture available for inspection.
  }
});

test('a credential reached through a second name for the same file is refused', async () => {
  // The credential is now asserted about on the descriptor that will actually be
  // read, not on a path checked beforehand. A hard link is the plain case that a
  // path check cannot see: the name the operator gave and the name an attacker
  // added are the same object with the same mode, so only the link count
  // distinguishes a file that is solely the operator's from one that is not.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-develop-link-'));
  const credential = path.join(root, 'key');
  fs.writeFileSync(credential, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.linkSync(credential, path.join(root, 'alias'));
  await assert.rejects(main(['readiness'], { RONOR_DEVELOPMENT_API_KEY_FILE: credential }),
    /credential_file_permissions_refused/);
  fs.rmSync(root, { recursive: true, force: true });
});
