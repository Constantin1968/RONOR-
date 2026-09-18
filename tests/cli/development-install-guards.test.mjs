import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const script = fs.readFileSync(new URL('../../scripts/install-development-verification-fix.sh', import.meta.url), 'utf8');
const start = script.indexOf('assert_clean_worktree() {');
const end = script.indexOf('\n}', start);
assert.ok(start >= 0 && end > start);
const guard = script.slice(start, end + 2);
for (const [name, command, allowed, marker] of [
  ['Git failure with empty stdout', 'echo "fatal: permission denied" >&2; return 128', false, 'workspace_status_unreadable'],
  ['dirty worktree', 'printf " M changed.txt\\n"; return 0', false, 'workspace_not_clean'],
  ['readable clean worktree', 'return 0', true, ''],
]) {
  test(`installer gate: ${name}`, () => {
    const run = spawnSync('bash', ['-c', `set -Eeuo pipefail\ndocker() { ${command}; }\n${guard}\nassert_clean_worktree\necho continued`], { encoding: 'utf8' });
    assert.equal(run.status === 0, allowed);
    assert.equal(run.stdout.includes('continued'), allowed);
    if (marker) assert.ok(run.stderr.includes(marker));
  });
}
