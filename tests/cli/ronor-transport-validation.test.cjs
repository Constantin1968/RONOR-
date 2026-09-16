// Argument contract of the transport validation tools. No network, no model,
// no development controller: every assertion here is about what the two scripts
// refuse and what exact request they would submit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = require('../../scripts/ronor-transport-validation-run.cjs');
const status = require('../../scripts/ronor-transport-validation-status.cjs');

const APPROVED = ['--approved-validation', '--id=transport-validation-20260915'];

test('the run driver refuses everything that is not an explicitly approved, identified mandate', () => {
  for (const [argv, reason] of [
    [[], 'validation_not_approved'],
    [['--id=transport-validation-20260915'], 'validation_not_approved'],
    [['--approved-validation'], 'validation_id_missing'],
    [['--approved-validation', '--id=Short'], 'validation_id_invalid'],
    [['--approved-validation', '--id=ok-but-has-spaces here'], 'validation_id_invalid'],
    [[...APPROVED, '--max-cost-usd=101'], 'validation_cost_invalid'],
    [[...APPROVED, '--max-cost-usd=0'], 'validation_cost_invalid'],
    [[...APPROVED, '--max-cost-usd=nonsense'], 'validation_cost_invalid'],
    [[...APPROVED, '--max-runtime-minutes=16'], 'validation_runtime_invalid'],
    [[...APPROVED, '--max-runtime-minutes=2.5'], 'validation_runtime_invalid'],
    [[...APPROVED, '--suite=nonexistent'], 'validation_suite_invalid'],
    [[...APPROVED, '--suite='], 'validation_suite_invalid'],
    [[...APPROVED, '--objective=do something else'], 'validation_argument_unknown'],
    [[...APPROVED, 'start'], 'validation_argument_unknown'],
  ]) {
    assert.throws(() => run.parseArguments(argv), error => error.code === reason,
      `${JSON.stringify(argv)} should be refused with ${reason}`);
  }
});

test('an approved mandate is bounded by the declared ceilings and defaults to them', () => {
  assert.deepEqual(run.parseArguments(APPROVED), {
    approved: true, dryRun: false, id: 'transport-validation-20260915', suite: 'transport',
    maxCostUsd: run.DEFAULTS.maxCostUsd, maxRuntimeMinutes: run.DEFAULTS.maxRuntimeMinutes,
  });
  assert.equal(run.CEILINGS.maxCostUsd, 100);
  assert.equal(run.CEILINGS.maxRuntimeMinutes, 15);
  assert.equal(run.CEILINGS.maxFixCycles, 1);
  const lowered = run.parseArguments([...APPROVED, '--max-cost-usd=5', '--max-runtime-minutes=10']);
  assert.equal(lowered.maxCostUsd, 5);
  assert.equal(lowered.maxRuntimeMinutes, 10);
});

test('the submitted request names the selected suites and forbids authorship, pushing and unrelated repair', () => {
  const request = run.buildRequest(run.parseArguments([...APPROVED, '--suite=all']));
  assert.equal(request.max_cost_usd, 100);
  assert.equal(request.max_runtime_minutes, 15);
  assert.equal(request.max_fix_cycles, 1);
  assert.deepEqual(Object.keys(request).sort(),
    ['max_cost_usd', 'max_fix_cycles', 'max_runtime_minutes', 'objective']);
  for (const file of run.TEST_FILES) assert.match(request.objective, new RegExp(file.replace(/[.]/g, '\\.')));
  for (const phrase of [
    'do not claim to have authored them',
    'Never push, merge, release, deploy, or rewrite history',
    'not an unrelated repository-wide repair',
    'Do not read credentials',
    'make no code change and report that accurately',
  ]) assert.ok(request.objective.includes(phrase), `objective should state: ${phrase}`);
});

test('a dry run discloses the request, starts no model and creates no run', async () => {
  const result = await run.run([...APPROVED, '--suite=all', '--dry-run'], {});
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.no_model_started, true);
  assert.equal(result.no_run_created, true);
  assert.equal(result.id, 'transport-validation-20260915');
  assert.deepEqual(result.test_files, [...run.TEST_FILES]);
});

test('a real start refuses to proceed without an architect key file', async () => {
  await assert.rejects(run.run(APPROVED, {}), error => error.code === 'architect_key_file_missing');
});

test('the request file is written with owner-only permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-validation-'));
  const target = path.join(directory, 'request.json');
  const written = run.writeRequest(run.buildRequest(run.parseArguments(APPROVED)), ['/proc/unwritable/request.json', target]);
  assert.equal(written, target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).max_fix_cycles, 1);
  assert.throws(() => run.writeRequest({}, ['/proc/unwritable/request.json']),
    error => error.code === 'request_path_unwritable');
  fs.rmSync(directory, { recursive: true, force: true });
});

const IDENTIFIED = ['--run=run_006cc7aa5f89f370b94b', '--mission=msn_mtt6t4q8_1304ee6c'];

test('the status watch refuses missing, malformed or unbounded arguments', () => {
  for (const [argv, reason] of [
    [[], 'status_run_missing'],
    [['--mission=msn_mtt6t4q8_1304ee6c'], 'status_run_missing'],
    [['--run=run_006cc7aa5f89f370b94b'], 'status_mission_missing'],
    [['--run=006cc7aa5f89f370b94b', '--mission=msn_mtt6t4q8_1304ee6c'], 'status_run_invalid'],
    [['--run=run_006cc7aa5f89f370b94b', '--mission=mission-1'], 'status_mission_invalid'],
    [[...IDENTIFIED, '--watch-seconds=901'], 'status_watch_invalid'],
    [[...IDENTIFIED, '--watch-seconds=0'], 'status_watch_invalid'],
    [[...IDENTIFIED, '--interval-seconds=121'], 'status_interval_invalid'],
    [[...IDENTIFIED, '--cancel'], 'status_argument_unknown'],
  ]) {
    assert.throws(() => status.parseArguments(argv, {}), error => error.code === reason,
      `${JSON.stringify(argv)} should be refused with ${reason}`);
  }
  assert.deepEqual(status.parseArguments(IDENTIFIED, {}), {
    run: 'run_006cc7aa5f89f370b94b', mission: 'msn_mtt6t4q8_1304ee6c',
    watchSeconds: status.DEFAULTS.watchSeconds, intervalSeconds: status.DEFAULTS.intervalSeconds,
  });
});

test('the observation is redacted to identifiers, status and cost', () => {
  const observation = status.redact({
    run: {
      run_id: 'run_006cc7aa5f89f370b94b', mission_id: 'msn_mtt6t4q8_1304ee6c', status: 'running',
      reason_code: null, attempt_count: 1, last_error: null, cost_usd: 0.5,
      objective: 'SECRET OBJECTIVE', transcript: 'SECRET TRANSCRIPT', api_key: 'SECRET KEY',
    },
    progress: { phase: 'tests' },
    transcript: 'SECRET TRANSCRIPT',
  });
  assert.deepEqual(Object.keys(observation).sort(), [
    'at', 'attempt_count', 'cost_usd', 'last_error', 'mission_id', 'progress',
    'reason_code', 'run_id', 'status',
  ]);
  assert.ok(!JSON.stringify(observation).includes('SECRET'));
});

test('the watch stops on a terminal status and never exceeds its budget', async () => {
  const statuses = ['queued', 'running', 'running', 'succeeded'];
  const lines = [];
  let clock = 0;
  const terminal = await status.watch(IDENTIFIED, { RONOR_ARCHITECT_API_KEY_FILE: '/run/secrets/key' }, {
    main: async () => ({ run: { run_id: 'run_006cc7aa5f89f370b94b', status: statuses.shift() } }),
    emit: line => lines.push(JSON.parse(line).status),
    sleep: async () => { clock += 15_000; },
    now: () => clock,
  });
  assert.deepEqual(terminal, { ok: true, terminal: true, status: 'succeeded' });
  assert.deepEqual(lines, ['queued', 'running', 'succeeded']); // Unchanged states are not reprinted.

  clock = 0;
  const expired = await status.watch([...IDENTIFIED, '--watch-seconds=30'], { RONOR_ARCHITECT_API_KEY_FILE: '/k' }, {
    main: async () => ({ run: { run_id: 'run_006cc7aa5f89f370b94b', status: 'running' } }),
    emit: () => {},
    sleep: async () => { clock += 15_000; },
    now: () => clock,
  });
  assert.deepEqual(expired, { ok: true, terminal: false, status: 'running' });
  assert.ok(clock <= 30_000);
});

test('the status watch refuses to read without an architect key file', async () => {
  await assert.rejects(status.watch(IDENTIFIED, {}, { main: async () => ({}) }),
    error => error.code === 'architect_key_file_missing');
});

test('a validation targets exactly one suite unless every suite is asked for', () => {
  assert.deepEqual(run.selectFiles('transport'), ['tests/runtime/automation-http-transport.test.ts']);
  assert.deepEqual(run.selectFiles('controller'), ['tests/runtime/development-controller.test.ts']);
  assert.deepEqual(run.selectFiles('lease'), ['tests/runtime/automation-run-lease.test.ts']);
  assert.deepEqual(run.selectFiles('all'), [...run.TEST_FILES]);
  assert.deepEqual(run.SUITE_KEYS, ['transport', 'controller', 'lease']);
});

test('the objective names only the selected suite and the command it must run', () => {
  const single = run.buildRequest(run.parseArguments([...APPROVED, '--suite=lease']));
  assert.match(single.objective, /npm test -- --runInBand tests\/runtime\/automation-run-lease\.test\.ts\./);
  assert.ok(!single.objective.includes('automation-http-transport.test.ts'));
  assert.ok(!single.objective.includes('development-controller.test.ts'));
  const every = run.buildRequest(run.parseArguments([...APPROVED, '--suite=all']));
  for (const file of run.TEST_FILES) assert.ok(every.objective.includes(file), `${file} missing`);
});

test('a dry run declares which suite it would validate and still starts nothing', async () => {
  const observation = await run.run([...APPROVED, '--suite=controller', '--dry-run'], {});
  assert.equal(observation.suite, 'controller');
  assert.deepEqual(observation.test_files, ['tests/runtime/development-controller.test.ts']);
  assert.equal(observation.no_model_started, true);
  assert.equal(observation.no_run_created, true);
});

test('the watch emits one line per state change, not one line per poll', async () => {
  const states = ['running', 'running', 'running', 'succeeded'];
  const lines = [];
  let poll = 0;
  const result = await status.watch(
    ['--run=run_7a79cd0bae49a5233b6d', '--mission=msn_mu3h5btm_54171a4b', '--interval-seconds=1'],
    { RONOR_ARCHITECT_API_KEY_FILE: '/run/secrets/key' },
    {
      emit: line => lines.push(JSON.parse(line)),
      sleep: async () => {},
      main: async () => ({
        run: {
          run_id: 'run_7a79cd0bae49a5233b6d',
          mission_id: 'msn_mu3h5btm_54171a4b',
          status: states[poll++],
        },
        progress: {},
      }),
    },
  );
  assert.equal(result.terminal, true);
  assert.deepEqual(lines.map(line => line.status), ['running', 'succeeded']);
  for (const line of lines) assert.equal(typeof line.at, 'string');
});
