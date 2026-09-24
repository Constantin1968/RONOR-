import type { VerifiedMaterial } from './verification-authorities';

// Test reports reach the Codex model only after the verifier has already proved,
// deterministically, that every command passed (testMaterialsProvePass). The model
// therefore needs the structured outcome and the closing lines of each log, where
// Jest prints its summary, and not up to 200 KB of raw output per command.
//
// Run run_58d01d6c7ca8f02729e5 sent about 82 KB of raw test logs in one call and
// lost the verdict to the deadline. Compaction keeps the call small and fast while
// the full artifact stays bound by its sha256 and byte count, which are passed
// through unchanged. Git diffs and status are never compacted: they are what the
// model is asked to judge.
export const TEST_LOG_TAIL_CHARS = 4_000;

function tail(value: unknown): { text: string; omitted_chars: number } {
  const text = typeof value === 'string' ? value : '';
  return text.length <= TEST_LOG_TAIL_CHARS ? { text, omitted_chars: 0 }
    : { text: text.slice(-TEST_LOG_TAIL_CHARS), omitted_chars: text.length - TEST_LOG_TAIL_CHARS };
}

function compactTestReport(content: string): string {
  let report: Record<string, unknown>;
  try { report = JSON.parse(content) as Record<string, unknown>; } catch { return content; }
  if (!report || report.schema !== 'ronor-test-report/v1' || !Array.isArray(report.results)) return content;
  return JSON.stringify({
    schema: report.schema, compacted: 'ronor-test-report-compact/v1', passed: report.passed, command_count: report.command_count,
    results: report.results.map((raw) => {
      const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const stdout = tail(r.stdout); const stderr = tail(r.stderr);
      return { id: r.id, executable: r.executable, args: r.args, passed: r.passed, exit_code: r.exit_code, signal: r.signal,
        duration_ms: r.duration_ms, stdout_tail: stdout.text, stdout_omitted_chars: stdout.omitted_chars,
        stderr_tail: stderr.text, stderr_omitted_chars: stderr.omitted_chars };
    }),
  });
}

export function compactMaterialsForModel(materials: VerifiedMaterial[]): VerifiedMaterial[] {
  return materials.map((item) => item.artifact.kind === 'test_report'
    ? { artifact: item.artifact, content: compactTestReport(item.content) } : item);
}
