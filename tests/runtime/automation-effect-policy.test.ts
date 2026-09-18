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

  it.each([
    [{ content: 'git', command: 'push' }, ['git', 'push'], 'other'],
    [{ command: 'git', content: 'push' }, ['git', 'push'], 'other'],
    [{ command: ['git', '', 'push'] }, ['git', '', 'push'], 'command'],
    [{ content: ['git', '', 'push'] }, ['git', '', 'push'], 'content'],
    [{ content: ['git', { command: 'push' }] }, ['git', 'push'], 'other'],
    [{ command: 'git', unexpected: 'push' }, ['git', 'push'], 'other'],
  ])('classifies the entire cross-field match in %j without changing the scan', (action, strings, locus) => {
    const text = ['ActionEvent', ...strings].join('\n');
    const decision = evaluateOpenHandsEffects({ items: [{ kind: 'ActionEvent', action }] }, ['run_tests']);
    expect(decision).toEqual({
      allowed: false, reason: 'git_push_forbidden',
      diagnostics: {
        rule: 'git_push_forbidden', scanned_actions: 1, scanned_chars: text.length,
        match_index: text.indexOf('git'), match_locus: locus,
      },
    });
  });

  it.each(['command', 'content', 'unexpected'])('ignores a leading join separator for %s', key => {
    const action = { empty: '', [key]: '../outside' };
    const text = ['ActionEvent', '', '../outside'].join('\n');
    const decision = evaluateOpenHandsEffects({ items: [{ kind: 'ActionEvent', action }] }, ['read_repo']);
    expect(decision).toEqual({
      allowed: false, reason: 'workspace_escape_forbidden',
      diagnostics: {
        rule: 'workspace_escape_forbidden', scanned_actions: 1, scanned_chars: text.length,
        match_index: text.indexOf('../') - 1, match_locus: key === 'unexpected' ? 'other' : key,
      },
    });
  });

  it('counts actual matched whitespace, unlike synthetic separators', () => {
    const decision = evaluateOpenHandsEffects({ items: [{
      kind: 'ActionEvent', action: { content: ' ', command: '../outside' },
    }] }, ['read_repo']);
    // The matched leading character is the synthetic newline, not the preceding
    // content space. The original regexp and its exact offset are unchanged.
    expect(decision.diagnostics).toMatchObject({ match_index: 13, match_locus: 'command' });
    const mixed = evaluateOpenHandsEffects({ items: [{
      kind: 'ActionEvent', action: { content: 'git', command: ' ', text: 'push' },
    }] }, ['read_repo']);
    expect(mixed.diagnostics?.match_locus).toBe('other');
  });

  it('preserves UTF-16 scan offsets and never includes object keys in the scan', () => {
    const action = { ignored_key: '😀', command: `${escalation} npm test` };
    const text = ['ActionEvent', '😀', `${escalation} npm test`].join('\n');
    const decision = evaluateOpenHandsEffects({ items: [{ kind: 'ActionEvent', action }] }, ['read_repo']);
    expect(decision.diagnostics).toEqual({
      rule: 'privilege_escalation_forbidden', scanned_actions: 1,
      scanned_chars: text.length, match_index: text.indexOf(escalation), match_locus: 'command',
    });
    expect(evaluateOpenHandsEffects({ items: [{
      kind: 'ActionEvent', action: { [escalation]: 'npm test' },
    }] }, ['run_tests']).allowed).toBe(true);
  });

  /*
   * Relative traversal inside the pattern operand of a read-only search.
   *
   * The refused command below is the one that killed validation run
   * `run_21acb846b133d67321e3` on 16 September 2026: a strictly reading search
   * for relative TypeScript imports, refused because the pattern contained the
   * traversal sequence. The exemption is confined to the pattern operand, so
   * every other position in the same command stays refused.
   */
  describe('relative traversal in a search pattern', () => {
    const up = ['..', '/'].join('');

    it('admits the search that was refused in production', () => {
      const command = `cd /workspace/project && grep -rln "adapters/http\\|from './http'\\|from '${up}adapters/http'" src/ tests/`;
      expect(evaluateOpenHandsEffects(pending(command), ['read_repo', 'run_tests']))
        .toMatchObject({ allowed: true, reason: 'within_isolated_mandate' });
    });

    it.each([
      [`grep -rln "from '${up}x'" src/ && cat ${up}${up}outside`, 'a traversal outside the pattern in the same action'],
      [`grep -rn foo ${up}${up}outside`, 'a traversal in the path operand'],
      [`grep -f ${up}${up}patterns src/`, 'a traversal in a pattern FILE'],
      [`cat "from '${up}x'"`, 'a quoted traversal given to a reading command that is not a search'],
      [`rg -g "${up}${up}outside/*" foo`, 'a traversal in a glob rather than the pattern'],
      [`grep -rln "from '${up}x'" src/ | rg foo ${up}${up}outside`, 'a traversal in a later stage of the pipeline'],
    ])('still refuses %s', (command) => {
      expect(evaluateOpenHandsEffects(pending(command), ['read_repo', 'run_tests']))
        .toMatchObject({ allowed: false, reason: 'workspace_escape_forbidden' });
    });

    /*
     * A bare `rg ../../outside` names no path: ripgrep reads the first operand as
     * the pattern and searches the working directory, so nothing outside the
     * worktree is opened. It is admitted for the same reason as the production
     * case above, and the rule is applied consistently rather than by exception.
     */
    it('admits a traversal-shaped pattern given as the sole operand of a search', () => {
      expect(evaluateOpenHandsEffects(pending(`rg ${up}${up}outside`), ['read_repo']))
        .toMatchObject({ allowed: true, reason: 'within_isolated_mandate' });
    });

    it('refuses an absolute escape even inside a search pattern', () => {
      const absolute = ['/et', 'c/passwd'].join('');
      expect(evaluateOpenHandsEffects(pending(`grep -rn "${absolute}" src/`), ['read_repo']))
        .toMatchObject({ allowed: false, reason: 'workspace_escape_forbidden' });
    });

    it('refuses a traversal in file content, which the exemption never reaches', () => {
      const events = { items: [{ kind: 'ActionEvent', action: { content: `import x from '${up}outside';` } }] };
      expect(evaluateOpenHandsEffects(events, ['read_repo', 'edit_worktree']))
        .toMatchObject({ allowed: false, reason: 'workspace_escape_forbidden' });
    });
  });
});
