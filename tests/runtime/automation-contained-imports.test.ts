import { evaluateOpenHandsEffects } from '../../src/runtime/automation/effect-policy';
import { relativeEscapeIsContainedImport, workspaceFileDepth } from '../../src/runtime/automation/module-specifier-escape';

const write = (path: unknown, file_text: string) => ({ items: [{ kind: 'ActionEvent', action: { command: 'create', path, file_text } }] });
const edit = ['read_repo', 'edit_worktree'] as const;

describe('contained relative imports in file content', () => {
  it.each([
    ['ES import', "import { assertMi9EnforcementAllowed } from '../../src/governance/mi9-enforcement';\n"],
    ['double quotes', 'import { a } from "../../src/a";\n'],
    ['side-effect import', "import '../../src/setup';\n"],
    ['require', "const a = require('../../src/a');\n"],
    ['dynamic import', "const a = await import('../../src/a');\n"],
    ['jest.mock with factory', "jest.mock('../../src/a', () => ({}));\n"],
    ['export from', "export * from '../../src/a';\n"],
  ])('allows a %s that resolves inside the workspace', (_label, text) => {
    const d = evaluateOpenHandsEffects(write('/workspace/project/tests/governance/x.test.ts', text), [...edit]);
    expect(d).toMatchObject({ allowed: true });
  });

  it('accepts a workspace-relative target path', () => {
    expect(evaluateOpenHandsEffects(write('tests/governance/x.test.ts', "import a from '../../src/a';"), [...edit]).allowed).toBe(true);
  });

  it.each([
    ['one step too many', '/workspace/project/tests/governance/x.test.ts', "import a from '../../../etc/passwd';"],
    ['a traversal later in the specifier', '/workspace/project/tests/x.test.ts', "import a from '../src/../../x';"],
    ['a target outside the workspace', '/tmp/x.test.ts', "import a from '../a';"],
    ['a target with a traversal', '/workspace/project/tests/../../x.ts', "import a from '../a';"],
    ['no target path', undefined, "import a from '../a';"],
    ['a traversal outside a module specifier', '/workspace/project/tests/x.test.ts', "const p = '../secrets';"],
    ['a string that only looks like a specifier', '/workspace/project/tests/x.test.ts', "const p = from('../a') + '../../../b';"],
    ['a shell line in content', '/workspace/project/scripts/x.sh', 'cat ../../../etc/hosts'],
    ['a trailing expression after the specifier', '/workspace/project/tests/x.test.ts', "require('../a' + '/../../../b');"],
  ])('still refuses %s', (_label, target, text) => {
    const d = evaluateOpenHandsEffects(write(target, text), [...edit]);
    expect(d.allowed).toBe(false); expect(d.reason).toBe('workspace_escape_forbidden');
  });

  it('never treats a template literal as a contained specifier', () => {
    // The scanner's delimiter set does not include a backtick, a pre-existing gap
    // recorded separately; the allowance itself refuses the form in any case.
    expect(relativeEscapeIsContainedImport('import(`../a`);', 8, 5)).toBe(false);
  });

  it('never exempts a traversal in a command', () => {
    const cmd = { items: [{ kind: 'ActionEvent', action: { path: '/workspace/project/tests/a/x.ts', command: "node -e \"require('../a')\"" } }] };
    expect(evaluateOpenHandsEffects(cmd, ['run_tests']).allowed).toBe(false);
  });

  it('does not tie content to a file when several actions are pending', () => {
    const two = { items: [
      { kind: 'ActionEvent', action: { path: '/workspace/project/tests/a/x.ts', file_text: "import a from '../../src/a';" } },
      { kind: 'ActionEvent', action: { path: '/workspace/project/b.ts', file_text: 'x' } },
    ] };
    expect(evaluateOpenHandsEffects(two, [...edit]).allowed).toBe(false);
  });

  it('keeps every other rule on the same content', () => {
    const d = evaluateOpenHandsEffects(write('/workspace/project/tests/a/x.ts', "import a from '../../src/a';\nconst s = 'sudo x';"), [...edit]);
    expect(d.allowed).toBe(false); expect(d.reason).toBe('privilege_escalation_forbidden');
  });

  it('computes depth only for provably contained paths', () => {
    expect(workspaceFileDepth('/workspace/project/a.ts')).toBe(0);
    expect(workspaceFileDepth('/workspace/project/tests/a/b.ts')).toBe(2);
    expect(workspaceFileDepth('/workspace/projectX/a.ts')).toBeNull();
    expect(workspaceFileDepth('tests/./a.ts')).toBeNull();
    expect(relativeEscapeIsContainedImport("import a from '../a';", 15, 0)).toBe(false);
  });
});
