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
    expect(evaluateOpenHandsEffects(pending('python3 -c "open(\'a\',\'w\').write(\'x\')"'), ['read_repo'])).toEqual({
      allowed: true,
      reason: 'within_isolated_mandate',
    });
  });
});
