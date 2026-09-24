// Narrow, read-only live preflight. Print no environment, credentials or raw database rows.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database(process.env.AUDIT_DB_PATH, { readonly: true, fileMustExist: true });
const job = 'dev_64de94f632fb3e7cab2c96584f796056cdd7862f720c3b64db18e7d211cec702';
const mission = 'msn_mtrqvmv8_ed4ab0a5';
const run = 'run_89afa1fe1d6c3438449e';
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_automation_runs WHERE status='running'").get().n, 0);
const rows = db.prepare('SELECT run_id, mission_id, status, attempt_count, mandate_json FROM runtime_automation_runs').all();
assert.equal(rows.length, 1);
assert.equal(rows[0].run_id, run);
assert.equal(rows[0].mission_id, mission);
assert.equal(rows[0].status, 'failed');
// Attempt 2 is the authorized 2026-09-08 probe that failed on the wire-shape
// refusal. Both recorded attempts ended without a completed model run.
assert.equal(rows[0].attempt_count, 2);
const mandate = JSON.parse(rows[0].mandate_json);
assert.equal(mandate.max_cost_usd, 1);
assert.equal(mandate.max_runtime_minutes, 15);
assert(Date.parse(mandate.expires_at) < Date.now(), 'original_mandate_must_be_expired');
const state = db.prepare('SELECT state_json FROM runtime_missions WHERE mission_id = ?').get(mission);
assert(state);
const worktree = '/automation-worktrees/project';
const git = (...args) => execFileSync('git', ['-C', worktree, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
}).trim();
assert.equal(git('rev-parse', 'HEAD'), '6562d6e7b76cb15eba7b4a65b60ee246e148d2a3');
assert.equal(git('branch', '--show-current'), 'automation/development-001');
assert.equal(git('diff', '--name-only'), 'tests/runtime/development-controller.test.ts');
assert.equal(git('diff', '--cached', '--name-only'), '');
const patch = git('diff', '--binary');
assert(patch.includes('invalid_development_job'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({ job, mission, run, runs: rows.length, attempt: rows[0].attempt_count,
  state_digest: hash(state.state_json), mandate_digest: hash(rows[0].mandate_json), patch_digest: hash(patch),
  mandate_expires_at: mandate.expires_at, model_started: false }));
db.close();
