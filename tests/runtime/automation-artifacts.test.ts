import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createWorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';

describe('authoritative workspace artifacts', () => {
  it('captures actual Git diff and status with stable digests and relative references', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-artifacts-'));
    const workspace = path.join(root, 'workspace');
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(workspace); mkdirSync(artifacts);
    execFileSync('git', ['init', workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'RONOR Test']);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'test@invalid.local']);
    writeFileSync(path.join(workspace, 'tracked.txt'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', workspace, 'commit', '-m', 'baseline'], { stdio: 'ignore' });
    writeFileSync(path.join(workspace, 'tracked.txt'), 'after\n');
    writeFileSync(path.join(workspace, 'new.txt'), 'new\n');

    const collector = createWorkspaceArtifactCollector(artifacts);
    const result = collector.collect(workspace, 'run-1', 'task-1');
    expect(result.map((item) => item.kind)).toEqual(['git_diff', 'git_status']);
    expect(result.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(result.every((item) => !path.isAbsolute(item.reference) && !item.reference.includes('..'))).toBe(true);
    expect(readFileSync(path.join(artifacts, result[0].reference), 'utf8')).toContain('-before');
    expect(readFileSync(path.join(artifacts, result[0].reference), 'utf8')).toContain('+new');
    expect(readFileSync(path.join(artifacts, result[1].reference), 'utf8')).toContain('new.txt');
    expect(collector.collect(workspace, 'run-1', 'task-1')).toEqual(result);
    expect(collector.verify(result)).toEqual(result);
    writeFileSync(path.join(artifacts, result[0].reference), 'tampered\n');
    expect(() => collector.verify(result)).toThrow('artifact_integrity_failed');
  });

  it('keeps staged and committed changes visible relative to the approved base without modifying the index', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-artifacts-base-'));
    const workspace = path.join(root, 'workspace'); const artifacts = path.join(root, 'artifacts');
    mkdirSync(workspace); mkdirSync(artifacts);
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init'); git('config', 'user.name', 'RONOR Test'); git('config', 'user.email', 'test@invalid.local');
    writeFileSync(path.join(workspace, 'tracked.txt'), 'baseline\n');
    git('add', '.'); git('commit', '-m', 'baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    const collector = createWorkspaceArtifactCollector(artifacts, { baseCommit });
    writeFileSync(path.join(workspace, 'tracked.txt'), 'staged-change\n');
    git('add', 'tracked.txt');
    const before = git('status', '--porcelain=v1');
    expect(collector.read(collector.collect(workspace, 'run', 'staged'))[0].content).toContain('+staged-change');
    expect(git('status', '--porcelain=v1')).toBe(before);
    git('commit', '-m', 'worker local commit');
    expect(git('status', '--porcelain=v1')).toBe('');
    expect(collector.read(collector.collect(workspace, 'run', 'committed'))[0].content).toContain('+staged-change');
    expect(git('status', '--porcelain=v1')).toBe('');
    symlinkSync('/etc/passwd', path.join(workspace, 'outside'));
    expect(() => collector.collect(workspace, 'run', 'symlink')).toThrow('artifact_untracked_path_refused');
  });

  it('refuses a secret in an untracked file as well as a malformed base', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-artifacts-new-secret-'));
    const workspace = path.join(root, 'workspace'); const artifacts = path.join(root, 'artifacts');
    mkdirSync(workspace); mkdirSync(artifacts);
    execFileSync('git', ['init', workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '--allow-empty', '-m', 'baseline'], { stdio: 'ignore' });
    writeFileSync(path.join(workspace, 'new-config.txt'), `api_key=${'s'.repeat(32)}\n`);
    expect(() => createWorkspaceArtifactCollector(artifacts).collect(workspace, 'run', 'new-secret')).toThrow('artifact_secret_material_refused');
    expect(() => createWorkspaceArtifactCollector(artifacts, { baseCommit: '--bad-ref' })).toThrow('artifact_base_commit_invalid');
  });

  it('refuses secret-like material before persisting a diff', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-artifacts-secret-'));
    const workspace = path.join(root, 'workspace');
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(workspace); mkdirSync(artifacts);
    execFileSync('git', ['init', workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'RONOR Test']);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'test@invalid.local']);
    writeFileSync(path.join(workspace, 'config.txt'), 'password=ordinary-placeholder\n');
    execFileSync('git', ['-C', workspace, 'add', 'config.txt']);
    execFileSync('git', ['-C', workspace, 'commit', '-m', 'baseline'], { stdio: 'ignore' });
    writeFileSync(path.join(workspace, 'config.txt'), `api_key=${'s'.repeat(32)}\n`);
    expect(() => createWorkspaceArtifactCollector(artifacts).collect(workspace, 'run-1', 'task-secret')).toThrow('artifact_secret_material_refused');
  });
});
