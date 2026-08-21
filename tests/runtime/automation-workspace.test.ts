import path from 'path';
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../../src/runtime/automation/workspace';

const root = path.resolve('C:/automation');
const snapshot = (overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  canonical_path: path.join(root, 'worktrees', 'agent-1'), canonical_approved_root: root,
  is_link: false, is_git_worktree: true, git_toplevel: path.join(root, 'worktrees', 'agent-1'),
  branch: 'agent/mission-1', head: 'a'.repeat(40), origin: 'https://github.com/Constantin1968/RONOR-.git', clean: true,
  ...overrides,
});
const policy = { approved_root: root, branch_prefix: 'agent/', expected_origin: 'https://github.com/Constantin1968/RONOR-.git', require_clean: true };

describe('automation workspace policy', () => {
  it('accepts only the dedicated canonical worktree', () => {
    expect(validateWorkspaceSnapshot(snapshot(), policy).valid).toBe(true);
  });

  it.each([
    ['workspace_outside_approved_root', { canonical_path: path.resolve('C:/outside') }],
    ['workspace_link_refused', { is_link: true }],
    ['workspace_not_dedicated_git_root', { git_toplevel: root }],
    ['protected_branch_refused', { branch: 'main' }],
    ['branch_outside_policy', { branch: 'agent-evil/mission' }],
    ['repository_identity_mismatch', { origin: 'https://example.invalid/other.git' }],
    ['workspace_not_clean', { clean: false }],
  ])('rejects %s', (reason, change) => {
    expect(validateWorkspaceSnapshot(snapshot(change), policy).reason).toBe(reason);
  });

  it('pins the expected base commit when supplied', () => {
    expect(validateWorkspaceSnapshot(snapshot(), { ...policy, expected_head: 'b'.repeat(40) }).reason).toBe('base_commit_mismatch');
  });
});
