import { launchAutomationRun } from '../../src/runtime/automation/background-run';
import type { AutomationRun } from '../../src/runtime/automation/contracts';

const complete: AutomationRun = {
  run_id: 'run-1', mission_id: 'mission-1', status: 'complete', cost_usd: 0,
  completed_assignments: 1, total_assignments: 1, reason: null,
};

describe('detached automation run supervisor', () => {
  it('returns immediately, then records the terminal state and releases control', async () => {
    const order: string[] = [];
    launchAutomationRun({
      execute: async () => { order.push('execute'); return complete; },
      lease: { finish: (status) => { order.push(`lease:${status}`); return true; } },
      control: { finish: () => { order.push('control:finish'); } },
      onUnhandledFailure: () => { order.push('failure'); },
    });
    expect(order).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['execute', 'lease:complete', 'control:finish']);
  });

  it('fails closed, releases resources and discards thrown adapter details', async () => {
    const order: string[] = [];
    launchAutomationRun({
      execute: async () => { throw new Error('Bearer secret-that-must-not-be-recorded'); },
      lease: { finish: (status) => { order.push(`lease:${status}`); return true; } },
      control: { finish: () => { order.push('control:finish'); } },
      onUnhandledFailure: () => { order.push('failure:fixed-code'); },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['failure:fixed-code', 'lease:failed', 'control:finish']);
    expect(JSON.stringify(order)).not.toContain('secret-that-must-not-be-recorded');
  });
});
