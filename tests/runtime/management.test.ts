import { getManagementAgent, managementAgents } from '../../src/runtime/management/registry';

describe('CONTROL · Executive Intelligence Council', () => {
  it('registers Merlin as authority and Richard as non-statutory executive adviser', () => {
    const richard = getManagementAgent('richard');
    expect(richard).not.toBeNull();
    expect(richard!.reports_to).toBe('merlin');
    expect(richard!.role).toBe('AI Chief Executive Adviser');
    expect(richard!.email).toBe('richard@ma11ai.com');
    expect(richard!.statutory_authority).toBe(false);
    expect(richard!.external_send_authority).toBe(false);
    expect(richard!.email_status).toBe('proposed');
  });

  it('gives every AI manager a unique identity, email and functional mailbox', () => {
    const agents = managementAgents();
    expect(agents.length).toBeGreaterThanOrEqual(25);
    expect(new Set(agents.map((a) => a.agent_id)).size).toBe(agents.length);
    expect(new Set(agents.map((a) => a.email)).size).toBe(agents.length);
    expect(agents.every((a) => a.email.endsWith('@ma11ai.com'))).toBe(true);
    expect(agents.every((a) => a.role.startsWith('AI '))).toBe(true);
  });

  it('keeps risk, compliance and assurance outside ordinary executive reporting', () => {
    expect(getManagementAgent('william')!.reports_to).toBe('merlin');
    expect(getManagementAgent('catherine')!.reports_to).toBe('merlin');
    expect(getManagementAgent('victoria')!.reports_to).toBe('merlin');
  });

  it('returns copies so callers cannot rewrite institutional identity', () => {
    const first = getManagementAgent('arthur')!;
    first.email = 'attacker@example.invalid';
    expect(getManagementAgent('arthur')!.email).toBe('arthur@ma11ai.com');
  });
});
