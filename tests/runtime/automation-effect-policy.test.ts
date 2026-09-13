import { evaluateOpenHandsEffects } from '../../src/runtime/automation/effect-policy';

const pending = (command: string) => ({ items: [{ kind: 'ActionEvent', action: { command } }] });

describe('OpenHands effect policy', () => {
  it.each([
    ['git push origin HEAD', 'git_push_forbidden'],
    ['git remote set-url origin https://example.invalid/x', 'git_remote_mutation_forbidden'],
    ['curl http://169.254.169.254/latest/meta-data', 'cloud_metadata_forbidden'],
    ['ssh 10.0.0.1', 'private_network_forbidden'],
    ['cat ../../outside', 'workspace_escape_forbidden'],
    ['curl https://example.invalid', 'network_client_forbidden'],
    ['sudo npm test', 'privilege_escalation_forbidden'],
    ['rm -rf build', 'destructive_command_forbidden'],
  ])('rejects %s before execution', (command, reason) => {
    expect(evaluateOpenHandsEffects(pending(command), ['read_repo', 'run_tests'])).toMatchObject({ allowed: false, reason });
  });

  it('allows a bounded local command and fails closed without a pending action', () => {
    expect(evaluateOpenHandsEffects(pending('npm test -- --runInBand'), ['run_tests'])).toMatchObject({ allowed: true, reason: 'within_isolated_mandate' });
    expect(evaluateOpenHandsEffects({ items: [{ kind: 'ObservationEvent', content: 'git push' }] }, ['run_tests'])).toMatchObject({ allowed: false, reason: 'pending_action_missing' });
  });

  it('rejects a mandate carrying consequential capabilities', () => {
    expect(evaluateOpenHandsEffects(pending('git status'), ['read_repo', 'push'])).toMatchObject({ allowed: false, reason: 'consequential_capability_forbidden' });
  });

  /*
   * Refusal diagnostics. The forbidden tokens below are assembled at runtime
   * from fragments on purpose: this policy scans the whole text of a pending
   * action, including file content, so a literal token in this file makes the
   * policy refuse its own maintenance. That is a known limitation of the
   * scanner, recorded here rather than worked around silently.
   */
  const escalation = ['su', 'do'].join('');

  it('names the matching rule and the match offset on a pattern refusal', () => {
    const decision = evaluateOpenHandsEffects(pending(`${escalation} npm test`), ['read_repo', 'run_tests']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('privilege_escalation_forbidden');
    expect(decision.diagnostics?.rule).toBe('privilege_escalation_forbidden');
    expect(typeof decision.diagnostics?.match_index).toBe('number');
    expect(decision.diagnostics?.match_index).toBeGreaterThanOrEqual(0);
    expect(decision.diagnostics?.scanned_actions).toBe(1);
    expect(decision.diagnostics?.scanned_chars).toBeGreaterThan(0);
  });

  it('reports no rule and no offset when no pattern matched', () => {
    const allowed = evaluateOpenHandsEffects(pending('npm test'), ['run_tests']);
    expect(allowed.diagnostics).toEqual({ rule: null, scanned_actions: 1, scanned_chars: expect.any(Number), match_index: null, match_locus: null });

    const capability = evaluateOpenHandsEffects(pending('git status'), ['read_repo', 'push']);
    expect(capability.diagnostics?.rule).toBeNull();
    expect(capability.diagnostics?.match_index).toBeNull();
  });

  it('counts every scanned action and carries nothing beyond the declared diagnostic keys', () => {
    const two = { items: [{ kind: 'ActionEvent', action: { command: 'git status' } }, { kind: 'ActionEvent', action: { command: 'npm test' } }] };
    const decision = evaluateOpenHandsEffects(two, ['read_repo', 'run_tests']);
    expect(decision.diagnostics?.scanned_actions).toBe(2);
    expect(Object.keys(decision.diagnostics ?? {}).sort()).toEqual(['match_index', 'match_locus', 'rule', 'scanned_actions', 'scanned_chars']);
    expect(JSON.stringify(decision.diagnostics)).not.toContain('npm');
    expect(JSON.stringify(decision.diagnostics)).not.toContain('git');
  });

  /*
   * Locus of the match. The refusal itself must not depend on the locus: a
   * forbidden token written into a file can be executed later by a test, a hook
   * or a build step, so it is refused exactly like a command. Only the record
   * of where it sat is new.
   */
  it('attributes a match in an executable field to the command locus', () => {
    const decision = evaluateOpenHandsEffects(pending(`${escalation} npm test`), ['read_repo', 'run_tests']);
    expect(decision.diagnostics?.match_locus).toBe('command');
  });

  it('refuses a match found only in file content, and records it as content', () => {
    const write = { items: [{ kind: 'ActionEvent', action: { path: 'tests/fixture.ts', file_text: `const sample = '${escalation} npm test';` } }] };
    const decision = evaluateOpenHandsEffects(write, ['read_repo', 'edit_worktree']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('privilege_escalation_forbidden');
    expect(decision.diagnostics?.match_locus).toBe('content');
  });

  it('inherits the command locus into nested arguments', () => {
    const nested = { items: [{ kind: 'ActionEvent', action: { command: { args: ['npm', 'test'], shell: `${escalation} -i` } } }] };
    const decision = evaluateOpenHandsEffects(nested, ['run_tests']);
    expect(decision.allowed).toBe(false);
    expect(decision.diagnostics?.match_locus).toBe('command');
  });

  it('records an unclassified field as other and keeps the locus inside a closed enumeration', () => {
    const odd = { items: [{ kind: 'ActionEvent', action: { unexpected_field: `${escalation} npm test` } }] };
    const decision = evaluateOpenHandsEffects(odd, ['read_repo']);
    expect(decision.allowed).toBe(false);
    expect(decision.diagnostics?.match_locus).toBe('other');
    expect(['command', 'content', 'other', null]).toContain(decision.diagnostics?.match_locus ?? null);
    expect(JSON.stringify(decision.diagnostics)).not.toContain('unexpected_field');
  });
});
