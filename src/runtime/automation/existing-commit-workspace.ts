import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CommitPins { base_commit: string; head_commit: string; }
export const FULL_COMMIT = /^[a-f0-9]{40}$/;
export const EXISTING_ASSIGNMENT = 'existing-commit';

export function validCommitPins(value: CommitPins): boolean {
  return typeof value.base_commit === 'string' && typeof value.head_commit === 'string' &&
    value.base_commit.length === 40 && value.head_commit.length === 40 &&
    FULL_COMMIT.test(value.base_commit) && FULL_COMMIT.test(value.head_commit) &&
    value.base_commit !== value.head_commit;
}

/** Read-only Git calls. No revision expressions, client paths, hooks or external diff drivers. */
export function inspectExistingCommit(workspaceRoot: string, pins: CommitPins, policy?: {
  approvedRoot: string; branch: string; origin: string;
}): { diff: Buffer; status: Buffer; diff_sha256: string; branch: string } {
  if (!validCommitPins(pins)) throw new Error('verification_pins_invalid');
  const workspace = realpathSync.native(workspaceRoot);
  if (lstatSync(workspaceRoot).isSymbolicLink()) throw new Error('verification_workspace_refused');
  if (policy) {
    const relative = path.relative(realpathSync.native(policy.approvedRoot), workspace);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('verification_workspace_refused');
  }
  const inspectionDeadline = Date.now() + 10_000;
  const git = (args: string[]) => {
    if (Date.now() >= inspectionDeadline) throw new Error('verification_workspace_timeout');
    return execFileSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-C', workspace, ...args,
  ], {
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.max(1, inspectionDeadline - Date.now()),
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    });
  };
  const text = (args: string[]) => git(args).toString('utf8').trim();
  if (realpathSync.native(text(['rev-parse', '--show-toplevel'])) !== workspace ||
      text(['rev-parse', '--is-inside-work-tree']) !== 'true' ||
      text(['rev-parse', 'HEAD']) !== pins.head_commit)
    throw new Error('verification_head_mismatch');
  const branch = text(['branch', '--show-current']);
  if (!branch || branch === 'main' || branch === 'master' ||
      policy && (branch !== policy.branch || text(['remote', 'get-url', 'origin']) !== policy.origin))
    throw new Error('verification_workspace_refused');
  for (const pin of [pins.base_commit, pins.head_commit]) {
    if (text(['rev-parse', '--verify', `${pin}^{commit}`]) !== pin)
      throw new Error('verification_pins_invalid');
  }
  git(['merge-base', '--is-ancestor', pins.base_commit, pins.head_commit]);
  // Hidden index changes, sparse checkouts, submodules and source symlinks are
  // not admitted by this deliberately narrow existing-commit operation.
  if (git(['ls-files', '-v', '-z']).toString().split('\0').filter(Boolean).some(line => !line.startsWith('H ')) ||
      git(['ls-tree', '-r', '-z', pins.head_commit]).toString().split('\0').some(line => /^(120000|160000) /.test(line)))
    throw new Error('verification_workspace_refused');
  if (git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']).length)
    throw new Error('verification_workspace_dirty');
  git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
  const diff = git(['diff', '--binary', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', pins.base_commit, pins.head_commit, '--']);
  if (!diff.length) throw new Error('verification_empty_range_refused');
  return {
    branch, diff, diff_sha256: crypto.createHash('sha256').update(diff).digest('hex'),
    status: Buffer.from(JSON.stringify({ schema: 'ronor-existing-commit/v1',
      base_commit: pins.base_commit, head_commit: pins.head_commit, clean: true })),
  };
}
