import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { SpawnSyncReturns } from 'child_process';
import { createWorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import { createAllowlistedTestExecutor, parseAllowedTestCommands } from '../../src/runtime/automation/test-executor';

const outcome = (status: number | null, stdout = '', stderr = '', error?: Error): SpawnSyncReturns<Buffer> => ({
  pid: 1, output: [null, Buffer.from(stdout), Buffer.from(stderr)], stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), status, signal: null, error,
});

describe('authoritative allowlisted test executor', () => {
  it('parses bounded commands and refuses shells, duplicates and invalid timeouts', () => {
    expect(parseAllowedTestCommands(JSON.stringify([{ id: 'jest', executable: 'npm', args: ['test', '--', '--runInBand'], timeout_ms: 60_000 }]))).toHaveLength(1);
    expect(parseAllowedTestCommands(JSON.stringify([{ id: 'shell', executable: 'powershell.exe', args: [], timeout_ms: 1000 }]))).toBeNull();
    expect(parseAllowedTestCommands(JSON.stringify([{ id: 'x', executable: 'npm', args: [], timeout_ms: 1 }]))).toBeNull();
    expect(parseAllowedTestCommands(JSON.stringify([{ id: 'x', executable: 'npm', args: [], timeout_ms: 1000 }, { id: 'x', executable: 'npm', args: [], timeout_ms: 1000 }]))).toBeNull();
  });

  it('passes arguments literally with shell disabled and records an authoritative report', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-test-executor-')); const workspace = path.join(root, 'workspace'); const artifactRoot = path.join(root, 'artifacts'); mkdirSync(workspace); mkdirSync(artifactRoot);
    const spawn = jest.fn(() => outcome(0, 'PASS'));
    const executor = createAllowlistedTestExecutor({ commands: [{ id: 'safe', executable: 'npm', args: ['test', '; touch escaped'], timeout_ms: 1000 }], artifacts: createWorkspaceArtifactCollector(artifactRoot), approvedRoot: root, spawn, baseEnv: { PATH: 'safe-path' } });
    const result = executor.run(workspace, 'run-1', 'task-1');
    expect(result.passed).toBe(true); expect(result.artifact.kind).toBe('test_report');
    const [, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(args).toEqual(['test', '; touch escaped']); expect(options.shell).toBe(false);
    expect(options.env).toEqual({ PATH: 'safe-path', CI: 'true', NODE_ENV: 'test', RONOR_AUTOMATION_TEST: 'true' });
  });

  it('stops on non-zero/timeout and emits a failed report', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-test-fail-')); const workspace = path.join(root, 'workspace'); const artifactRoot = path.join(root, 'artifacts'); mkdirSync(workspace); mkdirSync(artifactRoot);
    const spawn = jest.fn(() => outcome(null, '', 'timeout', new Error('ETIMEDOUT')));
    const executor = createAllowlistedTestExecutor({ commands: [{ id: 'jest', executable: 'npm', args: ['test'], timeout_ms: 1000 }, { id: 'never', executable: 'npm', args: ['test'], timeout_ms: 1000 }], artifacts: createWorkspaceArtifactCollector(artifactRoot), approvedRoot: root, spawn });
    const result = executor.run(workspace, 'run-1', 'task-1');
    expect(result.passed).toBe(false); expect(result.claims).toContain('tests:fail'); expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses secret material in captured test output', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ronor-test-secret-')); const workspace = path.join(root, 'workspace'); const artifactRoot = path.join(root, 'artifacts'); mkdirSync(workspace); mkdirSync(artifactRoot);
    const spawn = jest.fn(() => outcome(0, `api_key=${'x'.repeat(24)}`));
    const executor = createAllowlistedTestExecutor({ commands: [{ id: 'jest', executable: 'npm', args: ['test'], timeout_ms: 1000 }], artifacts: createWorkspaceArtifactCollector(artifactRoot), approvedRoot: root, spawn });
    expect(() => executor.run(workspace, 'run-1', 'task-1')).toThrow('artifact_secret_material_refused');
  });

  it('refuses a workspace outside its canonical approved root', () => {
    const approved = mkdtempSync(path.join(tmpdir(), 'ronor-test-approved-')); const outside = mkdtempSync(path.join(tmpdir(), 'ronor-test-outside-')); const artifactRoot = path.join(approved, 'artifacts'); mkdirSync(artifactRoot);
    const executor = createAllowlistedTestExecutor({ commands: [{ id: 'jest', executable: 'npm', args: ['test'], timeout_ms: 1000 }], artifacts: createWorkspaceArtifactCollector(artifactRoot), approvedRoot: approved, spawn: jest.fn(() => outcome(0)) });
    expect(() => executor.run(outside, 'run-1', 'task-1')).toThrow('test_workspace_outside_approved_root');
  });
});
