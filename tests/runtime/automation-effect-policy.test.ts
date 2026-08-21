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
    expect(evaluateOpenHandsEffects(pending(command), ['read_repo', 'run_tests'])).toEqual({ allowed: false, reason });
  });

  it('allows a bounded local command and fails closed without a pending action', () => {
    expect(evaluateOpenHandsEffects(pending('npm test -- --runInBand'), ['run_tests'])).toEqual({ allowed: true, reason: 'within_isolated_mandate' });
    expect(evaluateOpenHandsEffects({ items: [{ kind: 'ObservationEvent', content: 'git push' }] }, ['run_tests'])).toEqual({ allowed: false, reason: 'pending_action_missing' });
  });

  it('rejects a mandate carrying consequential capabilities', () => {
    expect(evaluateOpenHandsEffects(pending('git status'), ['read_repo', 'push'])).toEqual({ allowed: false, reason: 'consequential_capability_forbidden' });
  });
});
