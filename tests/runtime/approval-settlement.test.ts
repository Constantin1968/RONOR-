import {
  consumePendingExecution,
  createPendingExecution,
  resetPendingExecutions,
} from '../../src/runtime/api/approval-settlement';
import type { Provenance } from '../../src/runtime/api/middleware';

function provenance(id = 'req_pending'): Provenance {
  return {
    request_id: id,
    received_at: new Date(0).toISOString(),
    api_key_id: 'key_owner',
    api_key_label: 'owner',
    client_ip: '127.0.0.1',
    user_agent: 'test',
    role: 'operator',
    sanitisation_verdict: 'clean',
    sanitisation_findings: [],
  };
}

describe('server-side pending execution store', () => {
  beforeEach(() => resetPendingExecutions());

  test('binds settlement to the originating API key and consumes exactly once', () => {
    const created = createPendingExecution({
      execution: { kind: 'query', request: { query: 'hello' } },
      provenance: provenance(),
      env: {},
      apiKeyId: 'key_owner',
    });

    expect(consumePendingExecution(created.approvalId, 'key_other').status).toBe('key-mismatch');
    expect(consumePendingExecution(created.approvalId, 'key_owner').status).toBe('ready');
    expect(consumePendingExecution(created.approvalId, 'key_owner').status).toBe('not-found');
  });

  test('expires without releasing the stored execution', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const created = createPendingExecution({
      execution: {
        kind: 'mission',
        request: { objective: 'x', confidentiality_level: 'internal' },
      },
      provenance: provenance('req_expiring'),
      env: { RONOR_APPROVAL_TTL_MINUTES: '1' },
      apiKeyId: 'key_owner',
    });
    now.mockReturnValue(61_001);
    expect(consumePendingExecution(created.approvalId, 'key_owner').status).toBe('expired');
    expect(consumePendingExecution(created.approvalId, 'key_owner').status).toBe('not-found');
    now.mockRestore();
  });
});
