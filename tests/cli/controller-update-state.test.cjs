const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EXPECTED, assertState } = require('../../scripts/check-development-controller-update.cjs');
const state = () => ({
  jobs: [{ job_id: EXPECTED.job, mission_id: EXPECTED.mission }], runs: 0,
  workspace: { is_link: false, is_git_worktree: true, canonical_path: '/automation-worktrees/project',
    canonical_approved_root: '/automation-worktrees', git_toplevel: '/automation-worktrees/project',
    branch: EXPECTED.branch, head: EXPECTED.head, origin: EXPECTED.origin, clean: true },
  index: { uid: 10001, gid: 10001, mode: 0o600 },
  limits: { enabled: 'true', recovery: 'false', cost: '1', minutes: '15', cycles: '1' },
  verdict: { valid: false, reason: 'branch_outside_policy' },
});
test('only the observed initial state is accepted before replacement', () => assert.doesNotThrow(() => assertState(state(), 'before')));
test('the unchanged job and valid workspace are required after replacement', () => {
  const s = state(); s.verdict = { valid: true, reason: null };
  assert.doesNotThrow(() => assertState(s, 'after'));
  assert.throws(() => assertState(state(), 'after'), /workspace_still_refused/);
});
for (const [name, change, reason] of [
  ['new run', s => s.runs++, 'job_or_runs_changed'],
  ['missing job', s => s.jobs = [], 'job_or_runs_changed'],
  ['changed mission', s => s.jobs[0].mission_id = 'another', 'job_or_runs_changed'],
  ['neighbor branch', s => s.workspace.branch += '-evil', 'workspace_changed'],
  ['dirty worktree', s => s.workspace.clean = false, 'workspace_changed'],
  ['root-owned index', s => s.index.uid = 0, 'index_permissions_changed'],
  ['recovery enabled', s => s.limits.recovery = 'true', 'limits_changed'],
]) {
  test(`refuses ${name}`, () => {
    const s = state(); change(s);
    assert.throws(() => assertState(s, 'before'), new RegExp(reason));
  });
}
for (const phase of ['before', 'after']) {
  test(`stdin entrypoint actually checks state in ${phase} mode`, () => {
    const script = fs.readFileSync(path.join(__dirname, '../../scripts/check-development-controller-update.cjs'), 'utf8')
      .replace('const state = collect();', 'const state = JSON.parse(process.env.FIXTURE_STATE);');
    const result = spawnSync(process.execPath, ['-', phase], {
      input: script, encoding: 'utf8', env: { ...process.env, FIXTURE_STATE: JSON.stringify(state()) },
    });
    if (phase === 'before') {
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).ok, true);
    } else {
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).error, 'workspace_still_refused');
    }
  });
}
