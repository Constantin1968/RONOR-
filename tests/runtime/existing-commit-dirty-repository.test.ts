import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectExistingCommit } from '../../src/runtime/automation/existing-commit-workspace';

// REAL REPOSITORY, NO MOCKS. Every case below dirties an actual Git worktree on
// disk and asserts the refusal code the operator is shown, not merely that a
// refusal happened. A dirty tree must never reach an authority or produce a
// status artifact claiming `clean: true`.

let root: string;
let repo: string;
let base: string;
let head: string;

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

const pins = () => ({ base_commit: base, head_commit: head });

/** Rebuild the fixture before each case so one dirtied tree cannot leak into the next. */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-dirty-repo-'));
  repo = path.join(root, 'worktree');
  fs.mkdirSync(repo);
  git('init', '--quiet', '--initial-branch=automation/development-controller');
  git('config', 'user.email', 'offline@fixture.invalid');
  git('config', 'user.name', 'Offline Fixture');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'tool.sh'), '#!/bin/sh\nexit 0\n');
  git('add', '.gitignore', 'value.txt', 'tool.sh');
  git('commit', '--quiet', '-m', 'base offline fixture');
  base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
  git('commit', '--quiet', '-a', '-m', 'candidate offline fixture');
  head = git('rev-parse', 'HEAD');
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('accepts a genuinely clean worktree and says so in the status artifact', () => {
  const result = inspectExistingCommit(repo, pins());
  expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  expect(JSON.parse(result.status.toString())).toEqual({
    schema: 'ronor-existing-commit/v1', base_commit: base, head_commit: head, clean: true,
  });
  expect(result.diff.length).toBeGreaterThan(0);
  expect(result.branch).toBe('automation/development-controller');
});

it('names every flavour of dirtiness with verification_workspace_dirty', () => {
  const cases: Array<[string, () => void]> = [
    ['untracked file', () => fs.writeFileSync(path.join(repo, 'scratch.txt'), 'nou\n')],
    ['untracked directory', () => {
      fs.mkdirSync(path.join(repo, 'notes'));
      fs.writeFileSync(path.join(repo, 'notes', 'draft.md'), 'ciornă\n');
    }],
    ['modified tracked file', () => fs.writeFileSync(path.join(repo, 'value.txt'), 'modificat\n')],
    ['staged but uncommitted addition', () => {
      fs.writeFileSync(path.join(repo, 'added.txt'), 'adăugat\n');
      git('add', 'added.txt');
    }],
    ['staged modification of a tracked file', () => {
      fs.writeFileSync(path.join(repo, 'value.txt'), 'pregătit\n');
      git('add', 'value.txt');
    }],
    ['deleted tracked file', () => fs.rmSync(path.join(repo, 'value.txt'))],
    ['executable bit change', () => fs.chmodSync(path.join(repo, 'tool.sh'), 0o755)],
    ['unresolved local commit on top of the pinned candidate', () => {
      fs.writeFileSync(path.join(repo, 'value.txt'), 'peste candidat\n');
      git('commit', '--quiet', '-a', '-m', 'peste candidat');
    }],
  ];
  for (const [label, dirty] of cases) {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-dirty-case-'));
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', repo, path.join(clean, 'worktree')],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const original = repo;
    repo = path.join(clean, 'worktree');
    git('config', 'user.email', 'offline@fixture.invalid');
    git('config', 'user.name', 'Offline Fixture');
    git('checkout', '--quiet', '-B', 'automation/development-controller', head);
    try {
      dirty();
      // A commit on top of the pin changes HEAD, so the pin mismatch is caught first.
      const expected = label.startsWith('unresolved local commit')
        ? 'verification_head_mismatch' : 'verification_workspace_dirty';
      expect(() => inspectExistingCommit(repo, pins())).toThrow(expected);
    } finally {
      repo = original;
      fs.rmSync(clean, { recursive: true, force: true });
    }
  }
});

it('does not treat ignored build output as dirtiness', () => {
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'artefact.bin'), 'ieșire ignorată\n');
  expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  expect(JSON.parse(inspectExistingCommit(repo, pins()).status.toString()).clean).toBe(true);
});

it('refuses a hidden index change that porcelain alone would call clean', () => {
  git('update-index', '--assume-unchanged', 'value.txt');
  fs.writeFileSync(path.join(repo, 'value.txt'), 'murdar ascuns\n');
  expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  expect(() => inspectExistingCommit(repo, pins())).toThrow('verification_workspace_refused');
});

it('refuses an empty pinned range even when the tree is clean', () => {
  const empty = git('commit-tree', git('rev-parse', `${head}^{tree}`), '-p', head, '-m', 'gol');
  git('checkout', '--quiet', '-B', 'automation/development-controller', empty);
  expect(() => inspectExistingCommit(repo, { base_commit: head, head_commit: empty }))
    .toThrow('verification_empty_range_refused');
});
