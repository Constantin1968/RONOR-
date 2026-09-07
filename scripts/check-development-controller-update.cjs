'use strict';

const EXPECTED = Object.freeze({
  job: 'dev_64de94f632fb3e7cab2c96584f796056cdd7862f720c3b64db18e7d211cec702',
  mission: 'msn_mtrqvmv8_ed4ab0a5',
  branch: 'automation/development-001',
  head: '6562d6e7b76cb15eba7b4a65b60ee246e148d2a3',
  origin: 'https://github.com/Constantin1968/RONOR-.git',
});

function assertState(s, phase) {
  const reject = code => { throw new Error(code); };
  if (!['before', 'after'].includes(phase)) reject('invalid_phase');
  if (s.jobs.length !== 1 || s.jobs[0].job_id !== EXPECTED.job ||
      s.jobs[0].mission_id !== EXPECTED.mission || s.runs !== 0) reject('job_or_runs_changed');
  const w = s.workspace;
  if (w.is_link || !w.is_git_worktree ||
      w.canonical_path !== '/automation-worktrees/project' ||
      w.canonical_approved_root !== '/automation-worktrees' ||
      w.git_toplevel !== w.canonical_path || w.branch !== EXPECTED.branch ||
      w.head !== EXPECTED.head || w.origin !== EXPECTED.origin || !w.clean) reject('workspace_changed');
  if (s.index.uid !== 10001 || s.index.gid !== 10001 || s.index.mode !== 0o600) reject('index_permissions_changed');
  if (s.limits.enabled !== 'true' || s.limits.recovery !== 'false' ||
      s.limits.cost !== '1' || s.limits.minutes !== '15' || s.limits.cycles !== '1') reject('limits_changed');
  if (phase === 'before' && (s.verdict.valid || s.verdict.reason !== 'branch_outside_policy')) reject('precondition_changed');
  if (phase === 'after' && (!s.verdict.valid || s.verdict.reason !== null)) reject('workspace_still_refused');
}

function collect() {
  const fs = require('node:fs');
  const DB = require('/app/node_modules/better-sqlite3');
  const { inspectAutomationWorkspace, validateWorkspaceSnapshot } = require('/app/dist/runtime/automation/workspace.js');
  const e = process.env;
  if (e.AUDIT_DB_PATH !== '/app/data/development.db' ||
      e.RONOR_AUTOMATION_WORKTREE !== '/automation-worktrees/project' ||
      e.RONOR_AUTOMATION_WORKSPACE_ROOT !== '/automation-worktrees' ||
      e.RONOR_AUTOMATION_BRANCH !== EXPECTED.branch ||
      e.RONOR_AUTOMATION_EXPECTED_HEAD !== EXPECTED.head ||
      e.RONOR_AUTOMATION_EXPECTED_ORIGIN !== EXPECTED.origin) throw new Error('configuration_changed');
  const db = new DB(e.AUDIT_DB_PATH, { readonly: true, fileMustExist: true });
  const jobs = db.prepare('SELECT job_id,mission_id,created_at FROM runtime_development_jobs').all();
  const runs = db.prepare('SELECT COUNT(*) AS n FROM runtime_automation_runs').get().n;
  db.close();
  const workspace = inspectAutomationWorkspace(e.RONOR_AUTOMATION_WORKTREE, e.RONOR_AUTOMATION_WORKSPACE_ROOT);
  const verdict = validateWorkspaceSnapshot(workspace, {
    approved_root: e.RONOR_AUTOMATION_WORKSPACE_ROOT, branch_prefix: EXPECTED.branch,
    expected_origin: EXPECTED.origin, expected_head: EXPECTED.head, require_clean: true,
  });
  const index = fs.statSync(`${e.RONOR_AUTOMATION_WORKTREE}/.git/index`);
  return { jobs, runs, workspace, verdict, index: { uid: index.uid, gid: index.gid, mode: index.mode & 0o777 },
    limits: { enabled: e.RONOR_AUTOMATION_ENABLED, recovery: e.RONOR_AUTOMATION_RECOVERY_ENABLED,
      cost: e.RONOR_AUTOMATION_MAX_COST_USD, minutes: e.RONOR_AUTOMATION_MAX_RUNTIME_MINUTES,
      cycles: e.RONOR_AUTOMATION_MAX_FIX_CYCLES } };
}

module.exports = { EXPECTED, assertState };
if (require.main === module || process.argv[1] === '-') {
  try {
    const phase = process.argv[2];
    const state = collect();
    assertState(state, phase);
    console.log(JSON.stringify({ ok: true, phase, jobs: state.jobs, runs: state.runs,
      branch: state.workspace.branch, head: state.workspace.head, clean: true,
      workspace_valid: state.verdict.valid, reason: state.verdict.reason }));
  } catch (error) {
    const known = new Set(['invalid_phase', 'job_or_runs_changed', 'workspace_changed', 'index_permissions_changed',
      'limits_changed', 'precondition_changed', 'workspace_still_refused', 'configuration_changed']);
    console.error(JSON.stringify({ ok: false, error: known.has(error.message) ? error.message : 'state_read_failed' }));
    process.exitCode = 1;
  }
}
