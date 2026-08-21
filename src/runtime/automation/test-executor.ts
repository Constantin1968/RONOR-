import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import path from 'path';
import type { EvidenceArtifact } from './contracts';
import type { WorkspaceArtifactCollector } from './artifacts';

export interface AllowedTestCommand { id: string; executable: string; args: string[]; timeout_ms: number; }
export interface TestExecutionResult { passed: boolean; claims: string[]; artifact: EvidenceArtifact; }
export interface TestExecutor { run(workspaceRoot: string, runId: string, assignmentId: string, signal?: AbortSignal): TestExecutionResult; }
type Spawn = (file: string, args: readonly string[], options: Parameters<typeof spawnSync>[2]) => SpawnSyncReturns<Buffer>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const FORBIDDEN_EXECUTABLES = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wscript', 'cscript']);

export function parseAllowedTestCommands(value: string | undefined): AllowedTestCommand[] | null {
  if (!value) return null;
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) return null;
  const ids = new Set<string>(); const commands: AllowedTestCommand[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const basename = typeof item.executable === 'string' ? path.basename(item.executable).toLowerCase() : '';
    if (typeof item.id !== 'string' || !SAFE_ID.test(item.id) || ids.has(item.id) || typeof item.executable !== 'string' || item.executable.length > 500 || item.executable.includes('\0') || FORBIDDEN_EXECUTABLES.has(basename) ||
        !Array.isArray(item.args) || item.args.length > 50 || !item.args.every((arg) => typeof arg === 'string' && arg.length <= 1000 && !arg.includes('\0')) ||
        typeof item.timeout_ms !== 'number' || !Number.isInteger(item.timeout_ms) || item.timeout_ms < 1000 || item.timeout_ms > 30 * 60_000) return null;
    ids.add(item.id); commands.push({ id: item.id, executable: item.executable, args: item.args as string[], timeout_ms: item.timeout_ms });
  }
  return commands;
}

export function createAllowlistedTestExecutor(config: { commands: AllowedTestCommand[]; artifacts: WorkspaceArtifactCollector; approvedRoot: string; spawn?: Spawn; baseEnv?: NodeJS.ProcessEnv }): TestExecutor {
  if (config.commands.length < 1) throw new Error('test_commands_required');
  const spawn = config.spawn ?? ((file, args, options) => spawnSync(file, args, options));
  const approvedRoot = realpathSync.native(path.resolve(config.approvedRoot));
  return { run(workspaceRoot, runId, assignmentId, signal) {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(assignmentId)) throw new Error('test_identifier_invalid');
    const workspace = realpathSync.native(path.resolve(workspaceRoot));
    const relative = path.relative(approvedRoot, workspace);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || lstatSync(path.resolve(workspaceRoot)).isSymbolicLink()) throw new Error('test_workspace_outside_approved_root');
    const results: Array<Record<string, unknown>> = [];
    let passed = true;
    for (const command of config.commands) {
      if (signal?.aborted) throw new Error('test_execution_cancelled');
      const started = Date.now();
      const outcome = spawn(command.executable, command.args, {
        cwd: workspace, shell: false, windowsHide: true, timeout: command.timeout_ms, maxBuffer: 1024 * 1024,
        encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(config.baseEnv ?? {}), CI: 'true', NODE_ENV: 'test', RONOR_AUTOMATION_TEST: 'true' },
      });
      const stdout = Buffer.isBuffer(outcome.stdout) ? outcome.stdout.toString('utf8').slice(-100_000) : '';
      const stderr = Buffer.isBuffer(outcome.stderr) ? outcome.stderr.toString('utf8').slice(-100_000) : '';
      const ok = outcome.status === 0 && !outcome.error && outcome.signal === null;
      passed = passed && ok;
      results.push({ id: command.id, executable: path.basename(command.executable), args: command.args, passed: ok, exit_code: outcome.status, signal: outcome.signal, duration_ms: Date.now() - started, stdout, stderr });
      if (!ok) break;
    }
    const report = { schema: 'ronor-test-report/v1', passed, command_count: results.length, results };
    return { passed, claims: [`tests:${passed ? 'pass' : 'fail'}`, ...results.map((item) => `test:${item.id}:${item.passed ? 'pass' : 'fail'}`)], artifact: config.artifacts.recordTestReport(runId, assignmentId, report) };
  } };
}
