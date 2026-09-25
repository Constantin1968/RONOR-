/**
 * G1.1 — acțiuni tipizate: cu doar `repo.read` nu există scriere/comitere/
 * ștergere, indiferent de formă. Probe negative pentru noul strat operator.
 *
 * Ultimul test documentează golul stratului vechi (`effect-policy.ts` F02):
 * aceeași încărcătură via `python -c` este APROBATĂ acolo cu doar `read_repo`.
 * De aceea stratul vechi nu poate purta autonomie; noul strat tipizat poate.
 */
import { evaluateOpenHandsEffects } from '../../src/runtime/automation/effect-policy';
import {
  evaluateTypedOperatorAction,
  type OperatorActionType,
} from '../../src/runtime/operator/actions';

const READ_ONLY: readonly OperatorActionType[] = ['repo.read'];

describe('operator typed actions (G1.1)', () => {
  it('permite citirea mărginită', () => {
    expect(
      evaluateTypedOperatorAction({ type: 'repo.read', args: { path: 'src/proba/sum.ts' } }, READ_ONLY),
    ).toEqual({ allowed: true, reason: 'typed_action_permitted' });
  });

  it.each([
    ['scriere directă', { type: 'repo.edit', args: { path: 'src/proba/sum.ts' } }],
    ['comitere', { type: 'vcs.commit_local', args: { message: 'fix' } }],
    ['rulare teste nedelegată', { type: 'tests.run', args: { suiteId: 'proba-001-t1' } }],
    ['scriere via interpret', { type: 'repo.read', args: { path: 'x', cmd: 'python3 -c "open(\'a\',\'w\').write(\'x\')"' } }],
    ['ștergere via interpret', { type: 'repo.read', args: { path: 'x', cmd: 'python -c "import shutil; shutil.rmtree(\'x\')"' } }],
    ['citire secrete', { type: 'repo.read', args: { path: '/run/secrets/fixture_token' } }],
    ['evadare workspace', { type: 'repo.read', args: { path: '../../etc/passwd' } }],
    ['client rețea', { type: 'repo.read', args: { path: 'x', cmd: 'curl https://example.invalid' } }],
    ['escaladare privilegii', { type: 'repo.read', args: { path: 'x', cmd: 'sudo npm test' } }],
    ['comandă distructivă', { type: 'repo.read', args: { path: 'x', cmd: 'rm -rf build' } }],
    ['git push mascat', { type: 'vcs.commit_local', args: { message: 'fix; git push origin HEAD' } }],
  ])('refuză %s cu capabilitate read-only', (_label, action) => {
    const decision = evaluateTypedOperatorAction(action, READ_ONLY);
    expect(decision.allowed).toBe(false);
  });

  it('refuză tip necunoscut și argumente malformate', () => {
    expect(evaluateTypedOperatorAction({ type: 'shell.exec', args: {} }, READ_ONLY).allowed).toBe(false);
    expect(evaluateTypedOperatorAction({ type: 'repo.read', args: { path: '/etc/passwd' } }, ['repo.read']).allowed).toBe(
      false,
    );
    expect(evaluateTypedOperatorAction(null, READ_ONLY)).toEqual({ allowed: false, reason: 'action_malformed' });
  });

  it('DOCUMENTEAZĂ GOLUL VECHI (F02): stratul text aprobă scrierea via python cu doar read_repo', () => {
    const pending = (command: string) => ({ items: [{ kind: 'ActionEvent', action: { command } }] });
    // Comportamentul vechi, probat în audit: APROBAT (golul). Dacă într-o zi
    // devine refuzat, acest test pică intenționat — semnal că F02 s-a închis.
    // `toMatchObject`: pe `main` rezultatul poartă și un câmp `diagnostics`.
    expect(evaluateOpenHandsEffects(pending('python3 -c "open(\'a\',\'w\').write(\'x\')"'), ['read_repo'])).toMatchObject({
      allowed: true,
      reason: 'within_isolated_mandate',
    });
  });
});

/**
 * Ocolirile filtrului găsite la revizia din 25.09.2026: toate erau PERMISE cu
 * doar `repo.read`, printr-o cheie suplimentară `cmd`. Fiecare e acum refuzată
 * de două ori: cheia necunoscută e refuzată de lista albă, iar codul în linie e
 * refuzat și acolo unde textul liber e permis (mesajul de comitere, calea).
 */
const INLINE_INTERPRETERS: Array<[string, string]> = [
  ['node -e', 'node -e "require(\'fs\').writeFileSync(\'a\',\'x\')"'],
  ['node --eval', 'node --eval "process.exit(0)"'],
  ['nodejs -p', 'nodejs -p "1"'],
  ['bash -c', 'bash -c "echo x > a"'],
  ['bash -lc', 'bash -lc "echo x > a"'],
  ['/bin/bash --norc -c', '/bin/bash --norc -c "echo x > a"'],
  ['sh -c', 'sh -c "echo x > a"'],
  ['/bin/sh -ec', '/bin/sh -ec "echo x > a"'],
  ['perl -e', 'perl -e "open(F,\'>a\')"'],
  ['perl -ne', 'perl -ne "print"'],
  ['python -c', 'python -c "open(\'a\',\'w\')"'],
  ['python3 -c', 'python3 -c "open(\'a\',\'w\')"'],
  ['python3.11 -c', 'python3.11 -c "open(\'a\',\'w\')"'],
  ['python3.12 -c', 'python3.12 -c "open(\'a\',\'w\')"'],
  ['python2.7 -c', 'python2.7 -c "open(\'a\',\'w\')"'],
  ['/usr/bin/python3.13 -I -c', '/usr/bin/python3.13 -I -c "open(\'a\',\'w\')"'],
  ['python3 -Ic', 'python3 -Ic "open(\'a\',\'w\')"'],
  ['env python3.11 -c', 'env python3.11 -c "open(\'a\',\'w\')"'],
  ['ruby -e', 'ruby -e "File.write(\'a\',\'x\')"'],
  ['php -r', 'php -r "file_put_contents(\'a\',\'x\');"'],
  ['php8.3 -r', 'php8.3 -r "file_put_contents(\'a\',\'x\');"'],
];

describe('operator typed actions: ocolirile filtrului sunt închise', () => {
  it.each(INLINE_INTERPRETERS)('refuză %s strecurat într-o cheie suplimentară a lui repo.read', (_label, command) => {
    expect(evaluateTypedOperatorAction({ type: 'repo.read', args: { path: 'x', cmd: command } }, READ_ONLY)).toEqual({
      allowed: false,
      reason: 'unknown_arg:cmd',
    });
  });

  it.each(INLINE_INTERPRETERS)('refuză %s în textul liber permis (mesaj de comitere)', (_label, command) => {
    expect(
      evaluateTypedOperatorAction({ type: 'vcs.commit_local', args: { message: `fix; ${command}` } }, ['vcs.commit_local']),
    ).toEqual({ allowed: false, reason: 'interpreter_inline_code_forbidden' });
  });

  it.each(INLINE_INTERPRETERS)('refuză %s în cale', (_label, command) => {
    expect(evaluateTypedOperatorAction({ type: 'repo.read', args: { path: `x ${command}` } }, READ_ONLY)).toEqual({
      allowed: false,
      reason: 'interpreter_inline_code_forbidden',
    });
  });

  it.each([
    ['repo.read', { path: 'a', cmd: 'ls' }, 'unknown_arg:cmd'],
    ['repo.read', { path: 'a', argv: ['cat', 'a'] }, 'unknown_arg:argv'],
    ['repo.edit', { path: 'a', script: 'x' }, 'unknown_arg:script'],
    ['tests.run', { suiteId: 'proba-001-t1', command: 'npm test' }, 'unknown_arg:command'],
    ['vcs.commit_local', { message: 'fix', amend: true }, 'unknown_arg:amend'],
  ] as const)('refuză cheia necunoscută pentru %s', (type, args, reason) => {
    expect(evaluateTypedOperatorAction({ type, args }, [type])).toEqual({ allowed: false, reason });
  });

  it.each([
    ['menționarea unui interpretor fără cod în linie', 'actualizează documentația pentru python3.11 și node 20'],
    ['un nume care conține „sh”', 'refactorizează flush-ul -c din push.ts'],
    ['o opțiune fără cod', 'rulează node --version'],
  ])('nu refuză %s', (_label, message) => {
    expect(
      evaluateTypedOperatorAction({ type: 'vcs.commit_local', args: { message } }, ['vcs.commit_local']),
    ).toEqual({ allowed: true, reason: 'typed_action_permitted' });
  });
});
