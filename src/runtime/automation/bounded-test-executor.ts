import { spawn } from 'node:child_process';
import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceArtifactCollector } from './artifacts';
import type { AllowedTestCommand, TestExecutionResult } from './test-executor';

export interface BoundedTestExecutor {
  run(workspaceRoot: string, runId: string, assignmentId: string,
    deadline: number, signal: AbortSignal): Promise<TestExecutionResult>;
}

/** Used only in the existing isolated evidence container, never in the controller.
 * Reuses the server's parsed allowlist and artifact writer. No shell or inherited
 * credentials; deadline/disconnect kills the child process group on Linux.
 */
export function createBoundedTestExecutor(config: {
  commands: AllowedTestCommand[]; artifacts: WorkspaceArtifactCollector;
  approvedRoot: string; baseEnv: NodeJS.ProcessEnv;
}): BoundedTestExecutor {
  const root = realpathSync.native(config.approvedRoot);
  if (!config.commands.length) throw new Error('test_commands_required');
  return { async run(workspaceRoot, runId, assignmentId, deadline, signal) {
    if (process.platform !== 'linux' || lstatSync(workspaceRoot).isSymbolicLink() ||
        realpathSync.native(workspaceRoot) !== root) throw new Error('test_isolation_required');
    const results: Array<Record<string, unknown>> = [];
    for (const command of config.commands) {
      if (signal.aborted || Date.now() >= deadline) throw new Error('test_execution_cancelled');
      const started = Date.now();
      const outcome = await new Promise<{
        passed: boolean; exit_code: number | null; signal: string | null; stdout: string; stderr: string;
      }>((resolve) => {
        const child = spawn(command.executable, command.args, {
          cwd: root, shell: false, detached: true, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...config.baseEnv, CI: 'true', NODE_ENV: 'test', RONOR_AUTOMATION_TEST: 'true' },
        });
        let bytes = 0; let failed = false;
        const stdout: Buffer[] = []; const stderr: Buffer[] = [];
        const killGroup = () => {
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
        };
        const abort = () => { failed = true; killGroup(); };
        const timer = setTimeout(abort, Math.max(1, Math.min(command.timeout_ms, deadline - Date.now())));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { abort(); return; }
          chunks.push(chunk);
        };
        child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
        child.on('error', () => { failed = true; });
        child.once('close', (code, termination) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          // Do not leave background descendants behind even on a zero exit.
          killGroup();
          resolve({ passed: !failed && !signal.aborted && Date.now() < deadline && code === 0 && termination === null,
            exit_code: code, signal: termination,
            stdout: Buffer.concat(stdout).toString('utf8').slice(-100_000),
            stderr: Buffer.concat(stderr).toString('utf8').slice(-100_000) });
        });
      });
      results.push({ id: command.id, executable: path.basename(command.executable), args: command.args,
        ...outcome, duration_ms: Date.now() - started });
      if (!outcome.passed) break;
    }
    const passed = results.length === config.commands.length && results.every(r => r.passed === true);
    const artifact = config.artifacts.recordTestReport(runId, assignmentId, {
      schema: 'ronor-test-report/v1', passed, command_count: results.length, results,
    });
    return { passed, claims: [`tests:${passed ? 'pass' : 'fail'}`], artifact };
  } };
}
