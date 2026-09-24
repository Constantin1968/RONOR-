import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The tool dispatches one bounded run whose objective names test files by path.
// A named file absent from the worktree the author will test must stop the tool
// before a mandate is issued, because the author then substitutes a broad pattern
// and the run is reported complete without its subject ever being exercised.
const tool = require('../../scripts/ronor-transport-validation-run.cjs');

describe('transport validation tool test-file presence gate', () => {
  const roots: string[] = [];

  function worktree(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'ronor-validation-worktree-'));
    roots.push(root);
    for (const file of files) {
      const full = join(root, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, 'test("placeholder", () => { expect(true).toBe(true); });\n');
    }
    return root;
  }

  function env(root: string): NodeJS.ProcessEnv {
    return { RONOR_TRANSPORT_WORKTREE: root };
  }

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('refuses the exact suite whose file is absent, naming it, before any model starts', async () => {
    const root = worktree([tool.SUITES.controller.file, tool.SUITES.lease.file]);
    await expect(
      tool.run(['--approved-validation', '--id=absent-transport-file', '--suite=transport'], env(root)),
    ).rejects.toMatchObject({
      code: 'validation_test_file_absent',
      absentFiles: [tool.SUITES.transport.file],
    });
  });

  it('refuses a dry run too, so the supported preflight cannot report a request it could not honour', async () => {
    const root = worktree([tool.SUITES.controller.file]);
    await expect(
      tool.run(['--approved-validation', '--id=absent-dry-run', '--suite=transport', '--dry-run'], env(root)),
    ).rejects.toMatchObject({ code: 'validation_test_file_absent' });
  });

  it('refuses --suite=all when any single named file is absent, naming only the absent one', async () => {
    const root = worktree([tool.SUITES.transport.file, tool.SUITES.controller.file]);
    await expect(
      tool.run(['--approved-validation', '--id=absent-one-of-three', '--suite=all'], env(root)),
    ).rejects.toMatchObject({
      code: 'validation_test_file_absent',
      absentFiles: [tool.SUITES.lease.file],
    });
  });

  it('proceeds when every named file is present, and still starts no model on a dry run', async () => {
    const root = worktree(tool.TEST_FILES);
    const result = await tool.run(
      ['--approved-validation', '--id=present-all-files', '--suite=all', '--dry-run'],
      env(root),
    );
    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      test_files_present: true,
      no_model_started: true,
      no_run_created: true,
      worktree: root,
    });
    expect(result.test_files).toEqual([...tool.TEST_FILES]);
  });

  it('treats a directory or an unreadable path at the file name as absent, failing closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ronor-validation-worktree-'));
    roots.push(root);
    mkdirSync(join(root, tool.SUITES.transport.file), { recursive: true });
    expect(tool.absentTestFiles([tool.SUITES.transport.file], env(root)))
      .toEqual([tool.SUITES.transport.file]);
  });

  it('reads the worktree the controller actually mounts, not the process directory', () => {
    expect(tool.worktreeRoot({ RONOR_AUTOMATION_WORKTREE: '/automation-worktrees/project' }))
      .toBe('/automation-worktrees/project');
    expect(tool.worktreeRoot({
      RONOR_TRANSPORT_WORKTREE: '/tmp/override',
      RONOR_AUTOMATION_WORKTREE: '/automation-worktrees/project',
    })).toBe('/tmp/override');
  });
});
