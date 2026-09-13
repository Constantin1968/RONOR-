import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { inspectAutomationWorkspace, validateWorkspaceSnapshot } from '../../src/runtime/automation/workspace';

/*
 * The diagnostic counters were accepted with a test that builds a snapshot
 * object by hand, so the code that reads them from git had never been executed
 * and every counter had only ever been observed at zero. These tests drive
 * inspectAutomationWorkspace against a real repository made genuinely dirty in
 * each of the three distinct ways, and assert the counters separate them.
 *
 * The counters must stay diagnostic: a dirty worktree is refused for being
 * dirty, never for a counter value, so the refusal reason is asserted to remain
 * workspace_not_clean throughout.
 */

const origin = 'https://github.com/Constantin1968/RONOR-.git';
let root: string;
let repo: string;

const run = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (name: string, body: string) => fs.writeFileSync(path.join(repo, name), body);
const inspect = () => inspectAutomationWorkspace(repo, root);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-workspace-')));
  repo = path.join(root, 'worktrees', 'agent-1');
  fs.mkdirSync(repo, { recursive: true });
  run(['init', '--quiet', '--initial-branch', 'agent/mission-1']);
  run(['remote', 'add', 'origin', origin]);
  write('tracked.txt', 'baseline\n');
  write('second.txt', 'baseline\n');
  run(['add', 'tracked.txt', 'second.txt']);
  run(['-c', 'user.name=NrgPaths', '-c', 'user.email=ops@nrgpaths.invalid', 'commit', '--quiet', '-m', 'baseline']);
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const policy = { approved_root: '', branch_prefix: 'agent/', expected_origin: origin, require_clean: true };
const policyFor = () => ({ ...policy, approved_root: root });

describe('automation workspace counters on a real repository', () => {
  it('reports every counter at zero on a clean checkout', () => {
    const snapshot = inspect();
    expect(snapshot.clean).toBe(true);
    expect(snapshot.untracked_count).toBe(0);
    expect(snapshot.staged_count).toBe(0);
    expect(snapshot.unstaged_tracked_count).toBe(0);
    expect(snapshot.worktree_matches_index).toBe(true);
    expect(validateWorkspaceSnapshot(snapshot, policyFor()).valid).toBe(true);
  });

  it('counts untracked files without claiming the worktree diverged from the index', () => {
    write('left-behind.txt', 'residue\n');
    write('also-left.txt', 'residue\n');
    const snapshot = inspect();
    expect(snapshot.clean).toBe(false);
    expect(snapshot.untracked_count).toBe(2);
    expect(snapshot.staged_count).toBe(0);
    expect(snapshot.unstaged_tracked_count).toBe(0);
    // Untracked files are unknown to the index, so tracked content still matches it.
    expect(snapshot.worktree_matches_index).toBe(true);
    expect(validateWorkspaceSnapshot(snapshot, policyFor()).reason).toBe('workspace_not_clean');
  });

  it('counts a staged change separately from the worktree', () => {
    write('tracked.txt', 'staged change\n');
    run(['add', 'tracked.txt']);
    const snapshot = inspect();
    expect(snapshot.clean).toBe(false);
    expect(snapshot.staged_count).toBe(1);
    expect(snapshot.untracked_count).toBe(0);
    expect(snapshot.unstaged_tracked_count).toBe(0);
    expect(snapshot.worktree_matches_index).toBe(true);
    expect(validateWorkspaceSnapshot(snapshot, policyFor()).reason).toBe('workspace_not_clean');
  });

  it('counts an unstaged change to a tracked file and reports the worktree as diverged', () => {
    write('tracked.txt', 'unstaged change\n');
    const snapshot = inspect();
    expect(snapshot.clean).toBe(false);
    expect(snapshot.unstaged_tracked_count).toBe(1);
    expect(snapshot.staged_count).toBe(0);
    expect(snapshot.untracked_count).toBe(0);
    expect(snapshot.worktree_matches_index).toBe(false);
    expect(validateWorkspaceSnapshot(snapshot, policyFor()).reason).toBe('workspace_not_clean');
  });

  it('separates the three kinds when a repository is dirty in all of them at once', () => {
    write('tracked.txt', 'staged change\n');
    run(['add', 'tracked.txt']);
    write('second.txt', 'unstaged change\n');
    write('left-behind.txt', 'residue\n');
    const snapshot = inspect();
    expect(snapshot.staged_count).toBe(1);
    expect(snapshot.unstaged_tracked_count).toBe(1);
    expect(snapshot.untracked_count).toBe(1);
    expect(snapshot.worktree_matches_index).toBe(false);
    expect(validateWorkspaceSnapshot(snapshot, policyFor()).reason).toBe('workspace_not_clean');
  });

  it('counts a file that is both staged and further modified once in each counter', () => {
    write('tracked.txt', 'staged change\n');
    run(['add', 'tracked.txt']);
    write('tracked.txt', 'and modified again\n');
    const snapshot = inspect();
    expect(snapshot.staged_count).toBe(1);
    expect(snapshot.unstaged_tracked_count).toBe(1);
    expect(snapshot.worktree_matches_index).toBe(false);
    // The counters are not a partition of changed files and must not be summed.
    expect(snapshot.staged_count + snapshot.unstaged_tracked_count).toBe(2);
  });

  it('counts a deleted tracked file as an unstaged change, not as untracked', () => {
    fs.rmSync(path.join(repo, 'second.txt'));
    const snapshot = inspect();
    expect(snapshot.unstaged_tracked_count).toBe(1);
    expect(snapshot.untracked_count).toBe(0);
    expect(snapshot.worktree_matches_index).toBe(false);
  });

  it('honours the repository ignore rules when counting untracked files', () => {
    write('.gitignore', 'ignored.txt\n');
    run(['add', '.gitignore']);
    run(['-c', 'user.name=NrgPaths', '-c', 'user.email=ops@nrgpaths.invalid', 'commit', '--quiet', '-m', 'ignore rules']);
    write('ignored.txt', 'noise\n');
    const snapshot = inspect();
    expect(snapshot.untracked_count).toBe(0);
    expect(snapshot.clean).toBe(true);
  });
});
