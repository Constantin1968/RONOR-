import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { issueArchitectMandate } from '../../src/runtime/automation/mandate-issuer';
import { validateMandate } from '../../src/runtime/automation/policy';
import { inspectAndValidateWorkspace } from '../../src/runtime/automation/workspace';
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

  it('accepts an exact approved branch but refuses sibling and descendant names', () => {
    const exact = { ...policy, branch_prefix: 'agent/mission-1' };
    expect(validateWorkspaceSnapshot(snapshot(), exact).valid).toBe(true);
    for (const branch of ['agent/mission-10', 'agent/mission-1/child', 'agent/other', 'main']) {
      expect(validateWorkspaceSnapshot(snapshot({ branch }), exact).valid).toBe(false);
    }
  });

  it('accepts an issued exact-branch mandate against a real Git worktree without changing the index', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-exact-branch-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid.local');
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'fixture\n');
    git('add', '.'); git('commit', '-m', 'fixture'); git('switch', '-c', 'automation/development-001');
    const objective = 'Add one regression test';
    const mandate = issueArchitectMandate({
      missionId: 'mission_fixture', architectKeyId: 'key_abcdef123456', objective,
      workspaceRoot: workspace, branch: 'automation/development-001',
    }, { maxCostUsd: 1, maxRuntimeMinutes: 15, maxFixCycles: 1 }, 'fixture-signing-material-not-production');
    const index = path.join(workspace, '.git', 'index');
    const before = fs.readFileSync(index);
    const inspected = inspectAndValidateWorkspace(workspace, {
      approved_root: workspace, branch_prefix: mandate.branch_prefix, expected_head: git('rev-parse', 'HEAD'), require_clean: true,
    });
    expect(inspected.valid).toBe(true);
    expect(validateMandate(mandate, { objective, workspaceRoot: workspace, branch: inspected.snapshot!.branch }).valid).toBe(true);
    expect(fs.readFileSync(index).equals(before)).toBe(true);
  });
});
