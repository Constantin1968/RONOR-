import { execFileSync } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import path from 'path';

export interface WorkspaceSnapshot {
  canonical_path: string;
  canonical_approved_root: string;
  is_link: boolean;
  is_git_worktree: boolean;
  git_toplevel: string;
  branch: string;
  head: string;
  origin: string | null;
  clean: boolean;
}

export interface WorkspacePolicy {
  approved_root: string;
  branch_prefix: string;
  expected_origin?: string;
  expected_head?: string;
  require_clean?: boolean;
}

export interface WorkspaceVerdict { valid: boolean; reason: string | null; snapshot?: WorkspaceSnapshot; }

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function inspectAutomationWorkspace(workspaceRoot: string, approvedRoot: string): WorkspaceSnapshot {
  const canonicalPath = realpathSync.native(path.resolve(workspaceRoot));
  const canonicalApprovedRoot = realpathSync.native(path.resolve(approvedRoot));
  const top = realpathSync.native(git(canonicalPath, ['rev-parse', '--show-toplevel']));
  let origin: string | null = null;
  try { origin = git(canonicalPath, ['remote', 'get-url', 'origin']); } catch { origin = null; }
  return {
    canonical_path: canonicalPath,
    canonical_approved_root: canonicalApprovedRoot,
    is_link: lstatSync(path.resolve(workspaceRoot)).isSymbolicLink(),
    is_git_worktree: git(canonicalPath, ['rev-parse', '--is-inside-work-tree']) === 'true',
    git_toplevel: top,
    branch: git(canonicalPath, ['branch', '--show-current']),
    head: git(canonicalPath, ['rev-parse', 'HEAD']),
    origin,
    clean: git(canonicalPath, ['status', '--porcelain']).length === 0,
  };
}

export function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot, policy: WorkspacePolicy): WorkspaceVerdict {
  if (!inside(snapshot.canonical_path, snapshot.canonical_approved_root)) return { valid: false, reason: 'workspace_outside_approved_root' };
  if (snapshot.is_link) return { valid: false, reason: 'workspace_link_refused' };
  if (!snapshot.is_git_worktree || snapshot.git_toplevel !== snapshot.canonical_path) return { valid: false, reason: 'workspace_not_dedicated_git_root' };
  if (snapshot.branch === 'main' || snapshot.branch === 'master') return { valid: false, reason: 'protected_branch_refused' };
  if (!policy.branch_prefix.endsWith('/') || !snapshot.branch.startsWith(policy.branch_prefix)) return { valid: false, reason: 'branch_outside_policy' };
  if (policy.expected_origin && snapshot.origin !== policy.expected_origin) return { valid: false, reason: 'repository_identity_mismatch' };
  if (policy.expected_head && snapshot.head !== policy.expected_head) return { valid: false, reason: 'base_commit_mismatch' };
  if (policy.require_clean && !snapshot.clean) return { valid: false, reason: 'workspace_not_clean' };
  return { valid: true, reason: null, snapshot };
}

export function inspectAndValidateWorkspace(workspaceRoot: string, policy: WorkspacePolicy): WorkspaceVerdict {
  try { return validateWorkspaceSnapshot(inspectAutomationWorkspace(workspaceRoot, policy.approved_root), policy); }
  catch { return { valid: false, reason: 'workspace_inspection_failed' }; }
}
