import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * External acceptance gate (milestone M1).
 *
 * The coding agent works inside the workspace; the acceptance suite, the CI
 * definitions and the automation control code must not be changed by it. The
 * gate compares the workspace against the pinned base commit and fails the
 * verification if any protected path changed (committed, staged, unstaged or
 * untracked). Because protected paths are proven unchanged, the acceptance
 * tests executed from the workspace are byte-for-byte the base-commit suite.
 *
 * Every evaluation writes a receipt outside the workspace, so each run keeps
 * its evidence even when the verdict is a failure.
 */

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  'tests/acceptance/',
  '.github/',
  'src/runtime/automation/',
  'jest.config.js',
  'jest.config.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

export interface AcceptancePolicy { baseCommit: string; protectedPaths: readonly string[]; receiptRoot: string; suitePath: string; }

export interface AcceptanceVerdict {
  passed: boolean;
  violations: string[];
  base_commit: string;
  suite_tree: string | null;
  changed_paths: number;
  receipt_sha256: string;
  claims: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function isProtected(file: string, protectedPaths: readonly string[]): boolean {
  const normal = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return protectedPaths.some(p => (p.endsWith('/') ? normal.startsWith(p) || normal === p.slice(0, -1) : normal === p));
}

export function parseProtectedPaths(raw: string | undefined): readonly string[] {
  if (!raw) return DEFAULT_PROTECTED_PATHS;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 ||
      !value.every(v => typeof v === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(v) && !v.includes('..')))
    throw new Error('acceptance_protected_paths_invalid');
  // The acceptance suite itself is always protected, whatever the configuration says.
  return Array.from(new Set([...DEFAULT_PROTECTED_PATHS.slice(0, 1), ...value]));
}

/** Every path that differs from the base commit, including untracked files. */
export function changedPaths(root: string, baseCommit: string): string[] {
  const tracked = git(root, ['diff', '--name-only', '--no-renames', '-z', baseCommit, '--']).split('\0');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return Array.from(new Set([...tracked, ...untracked].filter(Boolean))).sort();
}

function treeAt(root: string, rev: string, suitePath: string): string | null {
  try { return git(root, ['rev-parse', `${rev}:${suitePath.replace(/\/$/, '')}`]).trim(); } catch { return null; }
}

export function evaluateAcceptanceGate(workspaceRoot: string, runId: string, assignmentId: string, policy: AcceptancePolicy,
  now: () => Date = () => new Date()): AcceptanceVerdict {
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(assignmentId)) throw new Error('acceptance_identifier_invalid');
  if (!COMMIT.test(policy.baseCommit)) throw new Error('acceptance_base_commit_invalid');
  git(workspaceRoot, ['merge-base', '--is-ancestor', policy.baseCommit, 'HEAD']);
  const changed = changedPaths(workspaceRoot, policy.baseCommit);
  const violations = changed.filter(file => isProtected(file, policy.protectedPaths));
  const baseTree = treeAt(workspaceRoot, policy.baseCommit, policy.suitePath);
  const headTree = treeAt(workspaceRoot, 'HEAD', policy.suitePath);
  if (baseTree === null) violations.push(`${policy.suitePath} (absent at base commit)`);
  else if (headTree !== baseTree) violations.push(`${policy.suitePath} (tree differs from base commit)`);
  const passed = violations.length === 0;
  const receipt = {
    schema: 'ronor-acceptance-receipt/v1', run_id: runId, assignment_id: assignmentId, evaluated_at: now().toISOString(),
    base_commit: policy.baseCommit, head_commit: git(workspaceRoot, ['rev-parse', 'HEAD']).trim(),
    suite_path: policy.suitePath, suite_tree: baseTree, protected_paths: policy.protectedPaths,
    changed_paths: changed, violations, passed,
  };
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const dir = path.join(policy.receiptRoot, runId, assignmentId);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  writeFileSync(path.join(dir, 'acceptance-receipt.json'), content, { mode: 0o640, flag: 'w' });
  const claims = passed
    ? [`acceptance_gate:passed suite_tree=${baseTree} receipt=${sha256}`]
    : [`acceptance_gate:violated receipt=${sha256}`, ...violations.slice(0, 20).map(v => `acceptance_gate:protected_path_changed ${v}`.slice(0, 2000))];
  return { passed, violations, base_commit: policy.baseCommit, suite_tree: baseTree, changed_paths: changed.length, receipt_sha256: sha256, claims };
}
