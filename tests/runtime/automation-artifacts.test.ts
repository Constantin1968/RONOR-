import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
    expect(readFileSync(path.join(artifacts, result[1].reference), 'utf8')).toContain('new.txt');
    expect(collector.collect(workspace, 'run-1', 'task-1')).toEqual(result);
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
