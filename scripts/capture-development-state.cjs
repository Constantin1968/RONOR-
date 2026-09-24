// Narrow, read-only live state capture for install-time before/after comparison.
// Unlike check-development-accounting-update.cjs, this pins no historical run id:
// it asserts the invariants that must hold during any install and prints a digest
// of the whole run/mission/ledger surface so the caller can prove nothing moved.
// Print no environment, credentials or raw database rows.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database(process.env.AUDIT_DB_PATH, { readonly: true, fileMustExist: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// An install must never run while work is in flight, and must never start work.
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_automation_runs WHERE status='running'").get().n, 0,
  'refuse_install_while_a_run_is_in_flight');

const runs = db.prepare(`SELECT run_id, mission_id, status, attempt_count, mandate_json
  FROM runtime_automation_runs ORDER BY run_id`).all();
const missions = db.prepare('SELECT mission_id, state_json FROM runtime_missions ORDER BY mission_id').all();
const jobs = db.prepare('SELECT COUNT(*) AS n FROM runtime_development_jobs').get().n;

const worktree = '/automation-worktrees/project';
const git = (...args) => execFileSync('git', ['-C', worktree, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
}).trim();

console.log(JSON.stringify({
  runs: runs.length,
  jobs,
  missions: missions.length,
  statuses: runs.map(r => `${r.run_id}:${r.status}:${r.attempt_count}`),
  runs_digest: hash(JSON.stringify(runs)),
  missions_digest: hash(JSON.stringify(missions)),
  head: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current'),
  worktree_digest: hash(git('status', '--porcelain') + '\u0000' + git('diff', '--binary')),
}));
db.close();
