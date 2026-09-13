import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main, controllerUrl } from '../../scripts/ronor-develop.mjs';

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
    // Leave the clearly labelled offline fixture available for inspection.
  }
});
