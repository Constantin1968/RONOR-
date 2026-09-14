import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { closeDb, getDb } from '../../src/audit/hash-chain';
import { resetSchemaGuard } from '../../src/runtime/ledgers/schema';
import { bootstrapApiKeys } from '../../src/runtime/api/auth';
import { createDevelopmentController } from '../../src/runtime/automation/development-controller';
import { createExistingCommitVerification } from '../../src/runtime/automation/existing-commit-verification';
import { createWorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import { inspectExistingCommit } from '../../src/runtime/automation/existing-commit-workspace';
import { createEvidenceRunnerApp } from '../../src/runtime/automation/services/evidence-runner';
import { createBoundedTestExecutor } from '../../src/runtime/automation/bounded-test-executor';
import { createAllowlistedTestExecutor } from '../../src/runtime/automation/test-executor';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import { signBudgetQuery, verifyBudgetQuery, verifyModelBudget } from '../../src/runtime/automation/model-budget';

// OFFLINE MOCK-TRANSPORT WORKFLOW. The evaluator is explicitly a test double.
// Local fixture Git/test execution, evidence integrity, budget signature and
// Ed25519/Victoria receipt verification use the real implementations.
const previousDb = process.env.AUDIT_DB_PATH;
let root: string, repo: string, artifactRoot: string;
let base: string, head: string;
let env: NodeJS.ProcessEnv;
let controller: ReturnType<typeof createDevelopmentController>;
let calls: string[];
let alter: (url: URL, body: any) => { status?: number; body?: any } | undefined;
let pauseEvidence: boolean;
let fetcher: typeof fetch;
const architect = crypto.randomBytes(32).toString('hex');
const admin = crypto.randomBytes(32).toString('hex');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const spec = () => ({ approved: true, base_commit: base, head_commit: head, max_cost_usd: 1, max_runtime_minutes: 1 });

beforeEach(() => {
  closeDb(); resetSchemaGuard(); process.env.AUDIT_DB_PATH = ':memory:';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-existing-test-'));
  repo = path.join(root, 'repo'); artifactRoot = path.join(root, 'artifacts');
  fs.mkdirSync(repo); fs.mkdirSync(artifactRoot);
  git('init', '-b', 'work/verification');
  git('config', 'user.name', 'Offline fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  git('add', 'value.txt'); git('commit', '-m', 'fixture base'); base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
  git('add', 'value.txt'); git('commit', '-m', 'fixture candidate'); head = git('rev-parse', 'HEAD');
  env = {
    RONOR_ARCHITECT_API_KEY: architect, RONOR_ADMIN_API_KEY: admin,
    RONOR_AUTOMATION_ENABLED: 'true', RONOR_AUTOMATION_RECOVERY_ENABLED: 'false',
    RONOR_AUTOMATION_WORKTREE: repo, RONOR_AUTOMATION_WORKSPACE_ROOT: root,
    RONOR_AUTOMATION_ARTIFACT_ROOT: artifactRoot, RONOR_AUTOMATION_BRANCH: 'work/verification',
    RONOR_AUTOMATION_EXPECTED_ORIGIN: 'https://example.invalid/fixture.git', RONOR_AUTOMATION_EXPECTED_HEAD: head,
    RONOR_AUTOMATION_MANDATE_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
    RONOR_AUTOMATION_CAPABILITY_KEY: crypto.randomBytes(32).toString('hex'),
    RONOR_EVIDENCE_RUNNER_TOKEN: crypto.randomBytes(32).toString('hex'),
    RONOR_CODEX_VERIFIER_TOKEN: crypto.randomBytes(32).toString('hex'),
    RONOR_ASSURANCE_TOKEN: crypto.randomBytes(32).toString('hex'),
    RONOR_EVIDENCE_RUNNER_URL: 'http://automation-evidence-runner:3005',
    RONOR_CODEX_VERIFIER_URL: 'http://codex-verifier:3002', RONOR_ASSURANCE_URL: 'http://victoria-assurance:3003',
  };
  bootstrapApiKeys(env);
  const artifacts = createWorkspaceArtifactCollector(artifactRoot);
  const testConfig = { artifacts, approvedRoot: repo, baseEnv: {},
    commands: [{ id: 'offline-node-test', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 1000 }] };
  const runner = createEvidenceRunnerApp({ token: env.RONOR_EVIDENCE_RUNNER_TOKEN!, workspaceRoot: repo, artifacts,
    tests: createAllowlistedTestExecutor(testConfig), boundedTests: createBoundedTestExecutor(testConfig) });
  const keys = crypto.generateKeyPairSync('ed25519');
  const codex = createCodexVerifierApp({
    serviceToken: env.RONOR_CODEX_VERIFIER_TOKEN!, artifacts,
    receiptPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    evaluator: { async evaluate(input) {
      const budget = verifyModelBudget(input.budgetToken!, env.RONOR_AUTOMATION_CAPABILITY_KEY!);
      expect(budget).toMatchObject({ role: 'verifier', mission_id: input.missionId, budget_id: input.missionId,
        ceiling_micro_usd: 1_000_000, prior_micro_usd: 0 });
      expect(input.materials.find(m => m.artifact.kind === 'git_diff')!.content).toContain('+candidate');
      return { verdict: 'pass', summary: 'MOCK EVALUATOR ONLY', evidence: ['mock-evaluation:pass'], cost_usd: 0.01 };
    } },
  });
  const victoria = createAssuranceAuthorityApp({ serviceToken: env.RONOR_ASSURANCE_TOKEN!, artifacts,
    receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  calls = []; alter = () => undefined; pauseEvidence = false;
  fetcher = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${url.hostname}${url.pathname}`);
    if (pauseEvidence && url.pathname === '/v1/verify-existing') {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new Error('MOCK INTERRUPTED'));
        init?.signal?.addEventListener('abort', abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }
    const apps = { 'automation-evidence-runner': runner, 'codex-verifier': codex, 'victoria-assurance': victoria };
    const app = apps[url.hostname as keyof typeof apps];
    if (!app) throw new Error('MOCK refuses unexpected host');
    const http = init?.method === 'POST' ? request(app).post(url.pathname) : request(app).get(url.pathname);
    const headers = new Headers(init?.headers);
    headers.forEach((value, name) => http.set(name, value));
    if (init?.body) http.send(JSON.parse(String(init.body)));
    const response = await http;
    const replacement = alter(url, response.body);
    return new Response(JSON.stringify(replacement?.body ?? response.body), { status: replacement?.status ?? response.status });
  };
  controller = createDevelopmentController(env, { verificationFetcher: fetcher });
});
afterEach(async () => {
  controller.stop();
  await new Promise(resolve => setTimeout(resolve, 20));
  closeDb(); resetSchemaGuard();
  // Fixture files are intentionally left available for inspection.
  if (previousDb === undefined) delete process.env.AUDIT_DB_PATH; else process.env.AUDIT_DB_PATH = previousDb;
});
const submit = (body: unknown = spec(), id = crypto.randomUUID(), key = architect) =>
  request(controller.app).post('/api/development/verify-existing')
    .set('Authorization', `Bearer ${key}`).set('Idempotency-Key', id).send(body as object);
const status = (id: string) => request(controller.app).get(`/api/development/verifications/${id}`)
  .set('Authorization', `Bearer ${architect}`);
async function terminal(id: string) {
  for (let i = 0; i < 500; i++) {
    const response = await status(id);
    if (['verified', 'failed', 'cancelled', 'interrupted'].includes(response.body.verification?.status)) return response.body.verification;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('MOCK workflow did not settle');
}

it('MOCK-labelled complete workflow uses real range/test/receipt gates without author or planner', async () => {
  const started = await submit();
  expect(started.status).toBe(202);
  const result = await terminal(started.body.verification.verification_id);
  expect(result).toMatchObject({ operation: 'verify-existing', full_development: false, status: 'verified',
    base_commit: base, head_commit: head, victoria_accepted: true, cost_usd: 0.01 });
  expect(result.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(calls).toEqual([
    'automation-evidence-runner/health', 'codex-verifier/health', 'victoria-assurance/health',
    'automation-evidence-runner/v1/verify-existing', 'codex-verifier/v1/verify', 'victoria-assurance/v1/assure',
  ]);
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM runtime_automation_runs').get()).toEqual({ n: 0 });
  const stored = getDb().prepare('SELECT payload FROM runtime_existing_commit_verifications').get() as { payload: string };
  expect(stored.payload).not.toContain('MOCK EVALUATOR ONLY');
  expect(JSON.parse(stored.payload).mandate.allowed_actions).toEqual(['read_repo', 'run_tests']);
  expect(JSON.stringify(result)).not.toContain(repo);
  expect(JSON.stringify(result)).not.toContain('candidate\\n');
});

it('requires architect authentication and refuses all client path/command/authority fields', async () => {
  expect((await request(controller.app).post('/api/development/verify-existing').send(spec())).status).toBe(401);
  expect((await submit(spec(), crypto.randomUUID(), admin)).status).toBe(403);
  for (const extra of [{ workspace_root: repo }, { command: 'node' }, { authority_signature: 'fake' }, { checkout: head }])
    expect((await submit({ ...spec(), ...extra })).status).toBe(400);
  expect(calls).toEqual([]);
});

it('rejects short, expression, wrong HEAD, nonancestor and dirty candidates before any remote work', async () => {
  const unrelated = git('commit-tree', git('rev-parse', `${head}^{tree}`), '-m', 'unrelated offline fixture');
  for (const pins of [
    { head_commit: head.slice(0, 8) }, { base_commit: 'HEAD~1' }, { head_commit: base, base_commit: head },
    { base_commit: 'f'.repeat(40) }, { base_commit: unrelated },
  ]) expect((await submit({ ...spec(), ...pins })).status).toBeGreaterThanOrEqual(400);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'dirty\n');
  const dirty = await submit();
  expect(dirty.status).toBe(422);
  // The operator must be told which refusal this is, not merely that it failed.
  expect(dirty.body).toEqual({ ok: false, error: 'verification_workspace_dirty' });
  expect(calls).toEqual([]);
});

it('rejects hidden index changes rather than trusting porcelain alone', () => {
  git('update-index', '--assume-unchanged', 'value.txt');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'hidden dirty\n');
  expect(git('status', '--porcelain')).toBe('');
  expect(() => inspectExistingCommit(repo, spec())).toThrow('verification_workspace_refused');
});

it('collects precisely the immutable base..head diff even when the worktree diff is empty', () => {
  const artifacts = createWorkspaceArtifactCollector(artifactRoot);
  expect(git('diff')).toBe('');
  const id = `verify_${'a'.repeat(64)}`;
  const result = artifacts.collectCommitRange!(repo, id, 'existing-commit', spec());
  const material = artifacts.read(result);
  const expected = execFileSync('git', ['-C', repo, 'diff', '--binary', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', base, head, '--'], { encoding: 'utf8' });
  expect(material.find(m => m.artifact.kind === 'git_diff')!.content).toBe(expected);
  expect(JSON.parse(material.find(m => m.artifact.kind === 'git_status')!.content)).toEqual({
    schema: 'ronor-existing-commit/v1', base_commit: base, head_commit: head, clean: true,
  });
});

it('fails closed on non-2xx Codex even when its body claims pass and never auto-retries', async () => {
  alter = url => url.hostname === 'codex-verifier' && url.pathname === '/v1/verify' ? { status: 503 } : undefined;
  const key = crypto.randomUUID();
  const started = await submit(spec(), key);
  const result = await terminal(started.body.verification.verification_id);
  expect(result.status).toBe('failed'); expect(result.victoria_accepted).toBe(false);
  expect(calls).not.toContain('victoria-assurance/v1/assure');
  const count = calls.length;
  expect((await submit(spec(), key)).body.verification.status).toBe('failed');
  expect(calls).toHaveLength(count);
  expect((await submit()).status).toBe(409); // Ambiguous remote failures retain admission until deadline.
});

it('Victoria rejects a forged but structurally valid receipt; no fabricated acceptance', async () => {
  alter = (url, body) => url.hostname === 'codex-verifier' && url.pathname === '/v1/verify'
    ? { body: { ...body, receipt: { ...body.receipt, signature: 'A'.repeat(86) } } } : undefined;
  const started = await submit();
  const result = await terminal(started.body.verification.verification_id);
  expect(calls).toContain('victoria-assurance/v1/assure');
  expect(result).toMatchObject({ status: 'failed', victoria_accepted: false, reason: 'verification_victoria_failed' });
});

it('refuses authority health identity substitution without invoking tests/models', async () => {
  alter = (url, body) => url.hostname === 'victoria-assurance' && url.pathname === '/health'
    ? { body: { ...body, service_id: 'not-victoria' } } : undefined;
  const started = await submit();
  expect((await terminal(started.body.verification.verification_id)).status).toBe('failed');
  expect(calls.every(c => c.endsWith('/health'))).toBe(true);
});

it('cancels without success, excludes second verification and normal author admission', async () => {
  pauseEvidence = true;
  const started = await submit();
  const id = started.body.verification.verification_id;
  for (let i = 0; i < 100 && !calls.includes('automation-evidence-runner/v1/verify-existing'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  expect((await submit()).status).toBe(409);
  expect((await request(controller.app).post('/api/runtime/control/automation/run')
    .set('Authorization', `Bearer ${architect}`).send({ approved: true })).status).toBe(409);
  expect((await request(controller.app).post(`/api/development/verifications/${id}/cancel`)
    .set('Authorization', `Bearer ${architect}`).send({})).body.verification.status).toBe('cancelled');
  expect((await terminal(id)).victoria_accepted).toBe(false);
  expect(calls).not.toContain('codex-verifier/v1/verify');
});

it('restart marks in-flight verification interrupted and never resumes it', async () => {
  pauseEvidence = true;
  const started = await submit();
  const id = started.body.verification.verification_id;
  const restarted = createExistingCommitVerification(env);
  expect((await status(id)).body.verification.status).toBe('interrupted');
  expect((await submit()).status).toBe(409);
  restarted.stop();
});

it('releases the admission barrier once the interrupted mandate deadline passes', async () => {
  // The barrier is deliberately retained after an interruption, because a lost
  // process may still hold an isolated test or model request. It must release
  // itself at the old mandate deadline: otherwise a single restart would wedge
  // the workspace permanently and no later verification could be admitted.
  pauseEvidence = true;
  const first = await submit();
  const id = first.body.verification.verification_id;
  createExistingCommitVerification(env).stop();
  expect((await status(id)).body.verification.status).toBe('interrupted');
  expect((await submit()).status).toBe(409);
  // Real elapsed time, not a manipulated clock: the mandate lasts one minute,
  // so the barrier may only clear after that minute has genuinely passed.
  const expires = Date.parse((await status(id)).body.verification.deadline);
  expect((await submit()).status).toBe(409);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now()) + 1_500));
  pauseEvidence = false;
  const next = await submit(spec(), crypto.randomUUID());
  expect(next.status).toBeLessThan(300);
  expect(await terminal(next.body.verification.verification_id))
    .toMatchObject({ status: 'verified', victoria_accepted: true });
}, 150_000);

it('persisted request/state corruption is refused and cannot turn a run into success', async () => {
  pauseEvidence = true;
  const started = await submit();
  const id = started.body.verification.verification_id;
  getDb().prepare('UPDATE runtime_existing_commit_verifications SET payload=? WHERE id=?')
    .run(JSON.stringify({ status: 'verified', raw: 'DO NOT DISCLOSE' }), id);
  const result = await status(id);
  expect(result.status).toBe(422);
  expect(result.body).toEqual({ ok: false, error: 'verification_integrity_failed' });
});

it('tampered artifacts invalidate a previously verified result on read', async () => {
  const started = await submit(); const id = started.body.verification.verification_id;
  expect((await terminal(id)).status).toBe('verified');
  fs.writeFileSync(path.join(artifactRoot, id, 'existing-commit', 'git.diff'), 'tampered');
  expect((await status(id)).body.verification).toMatchObject({
    status: 'failed', reason: 'verification_integrity_failed', victoria_accepted: false,
  });
});

it('shared runner gate prevents legacy synchronous tests from interleaving with new async tests', async () => {
  const artifacts = createWorkspaceArtifactCollector(artifactRoot);
  let finish!: () => void; let begun = false;
  const legacy = jest.fn();
  const app = createEvidenceRunnerApp({
    token: 'offline-test-service-token', workspaceRoot: repo, artifacts, tests: { run: legacy },
    boundedTests: { async run(_root, id, assignment) {
      begun = true;
      await new Promise<void>(resolve => { finish = resolve; });
      return { passed: true, claims: ['tests:pass'],
        artifact: artifacts.recordTestReport(id, assignment, { schema: 'ronor-test-report/v1',
          passed: true, command_count: 1, results: [{ id: 'mock-test', passed: true, exit_code: 0, signal: null }] }) };
    } },
  });
  const running = request(app).post('/v1/verify-existing').set('Authorization', 'Bearer offline-test-service-token')
    .send({ run_id: `verify_${'b'.repeat(64)}`, base_commit: base, head_commit: head,
      deadline: new Date(Date.now() + 60_000).toISOString() }).then(r => r);
  for (let i = 0; i < 100 && !begun; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(begun).toBe(true);
  const old = await request(app).post('/v1/verify').set('Authorization', 'Bearer offline-test-service-token')
    .send({ run_id: 'legacy', assignment_id: 'author', run_tests: true });
  expect(old.status).toBe(409); expect(legacy).not.toHaveBeenCalled();
  finish(); expect((await running).status).toBe(200);
});

it('test runner enforces a bounded child deadline and emits no passing report on timeout', async () => {
  const artifacts = createWorkspaceArtifactCollector(artifactRoot);
  const runner = createBoundedTestExecutor({ artifacts, approvedRoot: repo, baseEnv: {},
    commands: [{ id: 'offline-timeout', executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], timeout_ms: 1000 }] });
  const started = Date.now();
  const result = await runner.run(repo, 'timeout-fixture', 'existing-commit', Date.now() + 200, new AbortController().signal);
  expect(result.passed).toBe(false);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(JSON.parse(artifacts.read([result.artifact])[0].content).results[0].signal).toBe('SIGKILL');
});

it('observes the settled egress ledger for a run that ended without reporting a cost', async () => {
  // A codex-phase failure leaves the reported cost null, yet the provider was
  // already paid. The settled ledger is the only witness, and it lives in the
  // proxy container, so the controller must ask for it over a signed read.
  const egressUrl = 'http://model-egress-proxy:3004';
  let queried: { id: string; authorised: boolean } | null = null;
  const withLedger: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'model-egress-proxy') {
      const id = decodeURIComponent(url.pathname.replace('/budget/', ''));
      const proof = new Headers(init?.headers).get('x-ronor-budget-query') ?? '';
      const authorised = verifyBudgetQuery(proof, id, env.RONOR_AUTOMATION_CAPABILITY_KEY!);
      queried = { id, authorised };
      if (!authorised) return new Response(JSON.stringify({ ok: false }), { status: 401 });
      return new Response(JSON.stringify({ ok: true, protocol: 'ronor-model-egress/v1',
        rate_card: 'dashscope-intl-qwen3.8-max-20260902', budget_id: id, settled_micro_usd: 17284,
        settled_reservations: 2, pending_reservations: 1, outstanding_micro_usd: 40000, frozen: true }), { status: 200 });
    }
    return fetcher(input, init);
  };
  const local = createDevelopmentController({ ...env, RONOR_MODEL_EGRESS_URL: egressUrl },
    { verificationFetcher: withLedger });
  try {
    alter = (url, body) => url.pathname === '/v1/verify' ? { body: { ...body, verdict: 'fail' } } : undefined;
    const started = await request(local.app).post('/api/development/verify-existing')
      .set('Authorization', `Bearer ${architect}`).set('Idempotency-Key', crypto.randomUUID()).send(spec());
    const id = started.body.verification.verification_id;
    const read = () => request(local.app).get(`/api/development/verifications/${id}`)
      .set('Authorization', `Bearer ${architect}`);
    let verification: any;
    for (let i = 0; i < 500; i++) {
      verification = (await read()).body.verification;
      if (verification?.observed_cost_usd !== null && verification?.observed_cost_usd !== undefined) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(verification.status).toBe('failed');
    expect(verification.cost_usd).toBeNull();
    // Observed, not reported: recorded beside the missing figure, never as it.
    expect(verification.observed_cost_usd).toBeCloseTo(0.017284, 9);
    expect(verification.observed_cost_basis).toBe('egress-ledger-settled');
    expect(verification.observed_unresolved_dispatches).toBe(1);
    expect(verification.observed_budget_frozen).toBe(true);
    expect(verification.accounting_basis).toBe('catalog-not-invoice');
    expect(queried).toMatchObject({ id, authorised: true });
    expect(signBudgetQuery(id, env.RONOR_AUTOMATION_CAPABILITY_KEY!)).toHaveLength(43);
  } finally { local.stop(); }
});

it('records no observed cost when the egress ledger is unreachable or unconfigured', async () => {
  const refusing: typeof fetch = async (input, init) => {
    if (new URL(String(input)).hostname === 'model-egress-proxy') throw new Error('MOCK ledger unreachable');
    return fetcher(input, init);
  };
  const local = createDevelopmentController({ ...env, RONOR_MODEL_EGRESS_URL: 'http://model-egress-proxy:3004' },
    { verificationFetcher: refusing });
  try {
    alter = (url, body) => url.pathname === '/v1/verify' ? { body: { ...body, verdict: 'fail' } } : undefined;
    const started = await request(local.app).post('/api/development/verify-existing')
      .set('Authorization', `Bearer ${architect}`).set('Idempotency-Key', crypto.randomUUID()).send(spec());
    const id = started.body.verification.verification_id;
    let verification: any;
    for (let i = 0; i < 500; i++) {
      verification = (await request(local.app).get(`/api/development/verifications/${id}`)
        .set('Authorization', `Bearer ${architect}`)).body.verification;
      if (['failed', 'cancelled', 'interrupted', 'verified'].includes(verification?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    verification = (await request(local.app).get(`/api/development/verifications/${id}`)
      .set('Authorization', `Bearer ${architect}`)).body.verification;
    // An unreadable ledger is reported as unknown, never as zero.
    expect(verification.status).toBe('failed');
    expect(verification.observed_cost_usd).toBeNull();
    expect(verification.observed_cost_basis).toBeNull();
  } finally { local.stop(); }
});

/** Builds a controller whose egress ledger answers a signed read exactly as the
 * proxy would, so the barrier proof has a real authority to consult. */
function withLedgerController(budget: (id: string) => Response) {
  const withLedger: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'model-egress-proxy') {
      const id = decodeURIComponent(url.pathname.replace('/budget/', ''));
      if (!verifyBudgetQuery(new Headers(init?.headers).get('x-ronor-budget-query') ?? '', id,
        env.RONOR_AUTOMATION_CAPABILITY_KEY!))
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
      return budget(id);
    }
    return fetcher(input, init);
  };
  return createDevelopmentController({ ...env, RONOR_MODEL_EGRESS_URL: 'http://model-egress-proxy:3004' },
    { verificationFetcher: withLedger });
}
const unknownBudget = () => new Response(JSON.stringify({ ok: false, error: 'budget_unknown' }), { status: 404 });

it('returns the workspace after a cancellation once the worktree and the ledger prove nothing is left running', async () => {
  // Until now a verification cancelled after one second held the workspace for
  // the rest of its signed mandate. The barrier may be released early, but only
  // against proof: the evidence runner must report itself idle and the ledger
  // must show no dispatch outstanding. Both are asked, neither is assumed.
  pauseEvidence = true;
  const local = withLedgerController(unknownBudget);
  try {
    const architectHeader = { Authorization: `Bearer ${architect}` };
    const post = (path: string, body: object, key = crypto.randomUUID()) =>
      request(local.app).post(path).set(architectHeader).set('Idempotency-Key', key).send(body);
    const first = await post('/api/development/verify-existing', spec());
    const id = first.body.verification.verification_id;
    for (let i = 0; i < 200 && !calls.includes('automation-evidence-runner/v1/verify-existing'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    // While it is genuinely running, the workspace is closed to everyone.
    expect((await post('/api/development/verify-existing', spec())).status).toBe(409);
    expect((await post(`/api/development/verifications/${id}/cancel`, {})).body.verification.status).toBe('cancelled');
    pauseEvidence = false;
    let admitted: any;
    for (let i = 0; i < 200; i++) {
      admitted = await post('/api/development/verify-existing', spec());
      if (admitted.status < 300) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Released well inside the one-minute mandate, so this is the proof and not
    // the deadline expiring underneath the test.
    expect(admitted.status).toBeLessThan(300);
    expect(Date.parse((await request(local.app).get(`/api/development/verifications/${id}`)
      .set(architectHeader)).body.verification.deadline)).toBeGreaterThan(Date.now());
    expect(calls).toContain('automation-evidence-runner/health');
    expect(calls.filter(c => c === 'codex-verifier/v1/verify')).toHaveLength(0);
  } finally { local.stop(); }
});

it('keeps the barrier after a cancellation while a model dispatch is still unresolved', async () => {
  // An unresolved dispatch means the provider may still be working and may still
  // charge. That is exactly the case the deadline exists for, so the barrier
  // must stay even though the worktree itself is idle.
  pauseEvidence = true;
  const local = withLedgerController(id => new Response(JSON.stringify({ ok: true,
    protocol: 'ronor-model-egress/v1', rate_card: 'dashscope-intl-qwen3.8-max-20260902', budget_id: id,
    settled_micro_usd: 4000, settled_reservations: 1, pending_reservations: 1,
    outstanding_micro_usd: 200000, frozen: true }), { status: 200 }));
  try {
    const architectHeader = { Authorization: `Bearer ${architect}` };
    const post = (path: string, body: object) => request(local.app).post(path)
      .set(architectHeader).set('Idempotency-Key', crypto.randomUUID()).send(body);
    const first = await post('/api/development/verify-existing', spec());
    const id = first.body.verification.verification_id;
    for (let i = 0; i < 200 && !calls.includes('automation-evidence-runner/v1/verify-existing'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect((await post(`/api/development/verifications/${id}/cancel`, {})).body.verification.status).toBe('cancelled');
    pauseEvidence = false;
    for (let i = 0; i < 30; i++) {
      expect((await post('/api/development/verify-existing', spec())).status).toBe(409);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // The run stays terminal and the mandate has not expired, so the barrier is
    // held by the unresolved dispatch and not by the clock.
    const verification = (await request(local.app).get(`/api/development/verifications/${id}`)
      .set(architectHeader)).body.verification;
    expect(verification.status).toBe('cancelled');
    expect(Date.parse(verification.deadline)).toBeGreaterThan(Date.now());
  } finally { local.stop(); }
});

it('keeps the barrier when the evidence runner reports itself still busy', async () => {
  // The worktree authority is the evidence runner's own flag. If it says busy,
  // no ledger answer may override it: a test could still be writing files.
  pauseEvidence = true;
  const local = withLedgerController(unknownBudget);
  try {
    alter = (url, body) => url.hostname === 'automation-evidence-runner' && url.pathname === '/health'
      ? { body: { ...body, existing_verification_busy: true } } : undefined;
    const architectHeader = { Authorization: `Bearer ${architect}` };
    const post = (path: string, body: object) => request(local.app).post(path)
      .set(architectHeader).set('Idempotency-Key', crypto.randomUUID()).send(body);
    const first = await post('/api/development/verify-existing', spec());
    const id = first.body.verification.verification_id;
    for (let i = 0; i < 200 && !calls.includes('automation-evidence-runner/v1/verify-existing'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect((await post(`/api/development/verifications/${id}/cancel`, {})).body.verification.status).toBe('cancelled');
    pauseEvidence = false;
    for (let i = 0; i < 30; i++) {
      expect((await post('/api/development/verify-existing', spec())).status).toBe(409);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { local.stop(); }
});
