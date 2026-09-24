import { compactMaterialsForModel, TEST_LOG_TAIL_CHARS } from '../../src/runtime/automation/services/codex-evidence-compaction';

const artifact = (kind: 'git_diff' | 'test_report') => ({ kind, sha256: 'a'.repeat(64), reference: `r/${kind}`, bytes: 123 });

describe('Codex evidence compaction', () => {
  const longLog = 'x'.repeat(50_000) + '\nTests:       455 passed, 455 total\n';
  const report = JSON.stringify({ schema: 'ronor-test-report/v1', passed: true, command_count: 1,
    results: [{ id: 'jest', executable: 'npm', args: ['test'], passed: true, exit_code: 0, signal: null, duration_ms: 5, stdout: 'ok', stderr: longLog }] });

  it('keeps the structured outcome and the log summary, drops the bulk', () => {
    const [out] = compactMaterialsForModel([{ artifact: artifact('test_report'), content: report }]);
    const parsed = JSON.parse(out.content);
    expect(parsed.passed).toBe(true);
    expect(parsed.results[0]).toMatchObject({ id: 'jest', passed: true, exit_code: 0, signal: null, stdout_tail: 'ok', stdout_omitted_chars: 0 });
    expect(parsed.results[0].stderr_tail.length).toBe(TEST_LOG_TAIL_CHARS);
    expect(parsed.results[0].stderr_tail).toContain('Tests:       455 passed, 455 total');
    expect(parsed.results[0].stderr_omitted_chars).toBe(longLog.length - TEST_LOG_TAIL_CHARS);
    expect(out.content.length).toBeLessThan(report.length / 5);
  });

  it('passes the artifact binding through unchanged', () => {
    const a = artifact('test_report');
    expect(compactMaterialsForModel([{ artifact: a, content: report }])[0].artifact).toBe(a);
  });

  it('never compacts diffs, and leaves unknown or malformed reports intact', () => {
    const diff = { artifact: artifact('git_diff'), content: 'y'.repeat(60_000) };
    expect(compactMaterialsForModel([diff])[0]).toBe(diff);
    for (const content of ['not json', JSON.stringify({ schema: 'other' })]) {
      expect(compactMaterialsForModel([{ artifact: artifact('test_report'), content }])[0].content).toBe(content);
    }
  });
});
