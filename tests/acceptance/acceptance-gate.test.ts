import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_PROTECTED_PATHS, evaluateAcceptanceGate, isProtected, parseProtectedPaths } from '../../src/runtime/automation/acceptance-gate';

/*
 * Acceptance suite, milestone M1. This directory is protected: a run that changes
 * anything under tests/acceptance/ fails the gate before its tests can count.
 */
function repo(): { root: string; base: string; receipts: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ronor-acc-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'acc');
  mkdirSync(path.join(root, 'tests/acceptance'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'tests/acceptance/x.test.ts'), 'test("x", () => {});\n');
  writeFileSync(path.join(root, 'src/app.ts'), 'export const a = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  return { root, base: g('rev-parse', 'HEAD').trim(), receipts: mkdtempSync(path.join(os.tmpdir(), 'ronor-acc-r-')) };
}
const policy = (base: string, receipts: string) => ({ baseCommit: base, protectedPaths: DEFAULT_PROTECTED_PATHS, receiptRoot: receipts, suitePath: 'tests/acceptance' });

describe('external acceptance gate', () => {
  it('passes an ordinary source change and writes a receipt outside the workspace', () => {
    const { root, base, receipts } = repo();
    writeFileSync(path.join(root, 'src/app.ts'), 'export const a = 2;\n');
    const v = evaluateAcceptanceGate(root, 'run-1', 'task-1', policy(base, receipts));
    expect(v.passed).toBe(true); expect(v.changed_paths).toBe(1);
    const receipt = JSON.parse(readFileSync(path.join(receipts, 'run-1/task-1/acceptance-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ schema: 'ronor-acceptance-receipt/v1', passed: true, base_commit: base, changed_paths: ['src/app.ts'] });
    rmSync(root, { recursive: true }); rmSync(receipts, { recursive: true });
  });

  it.each([
    ['an edited acceptance test', 'tests/acceptance/x.test.ts'],
    ['a new acceptance test', 'tests/acceptance/y.test.ts'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['the automation control code', 'src/runtime/automation/policy.ts'],
    ['the test runner configuration', 'jest.config.js'],
    ['the package scripts', 'package.json'],
  ])('fails when the agent touches %s', (_label, file) => {
    const { root, base, receipts } = repo();
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), 'changed\n');
    const v = evaluateAcceptanceGate(root, 'run-2', 'task-2', policy(base, receipts));
    expect(v.passed).toBe(false); expect(v.violations).toContain(file);
    expect(v.claims[0]).toMatch(/^acceptance_gate:violated receipt=[a-f0-9]{64}$/);
    rmSync(root, { recursive: true }); rmSync(receipts, { recursive: true });
  });

  it('fails when a protected file is deleted in a commit, not only in the worktree', () => {
    const { root, base, receipts } = repo();
    execFileSync('git', ['-C', root, 'rm', '-q', 'tests/acceptance/x.test.ts']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'drop acceptance']);
    const v = evaluateAcceptanceGate(root, 'run-3', 'task-3', policy(base, receipts));
    expect(v.passed).toBe(false); expect(v.violations).toContain('tests/acceptance/x.test.ts');
    rmSync(root, { recursive: true }); rmSync(receipts, { recursive: true });
  });

  it('refuses a base commit that is not an ancestor of the workspace', () => {
    const { root, receipts } = repo();
    expect(() => evaluateAcceptanceGate(root, 'run-4', 'task-4', policy('0'.repeat(40), receipts))).toThrow();
    rmSync(root, { recursive: true }); rmSync(receipts, { recursive: true });
  });

  it('keeps the acceptance suite protected even when the configuration omits it', () => {
    const paths = parseProtectedPaths('["docs/"]');
    expect(isProtected('tests/acceptance/a.test.ts', paths)).toBe(true);
    expect(isProtected('docs/a.md', paths)).toBe(true);
    expect(isProtected('src/app.ts', paths)).toBe(false);
    expect(() => parseProtectedPaths('["../etc/"]')).toThrow('acceptance_protected_paths_invalid');
  });
});
