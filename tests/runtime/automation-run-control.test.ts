import { cancelAutomationRun, registerAutomationRun } from '../../src/runtime/automation/run-control';

describe('automation run control', () => {
  it('cancels the matching active run and cleans it up', () => {
    const control = registerAutomationRun('run-1', 'mission-1');
    expect(control).not.toBeNull();
    expect(control!.signal.aborted).toBe(false);
    expect(cancelAutomationRun('run-1', 'mission-1')).toBe('cancelled');
    expect(control!.signal.aborted).toBe(true);
    control!.finish();
    expect(cancelAutomationRun('run-1', 'mission-1')).toBe('not_found');
  });

  it('refuses duplicate registration and hides mission mismatches', () => {
    const control = registerAutomationRun('run-2', 'mission-2')!;
    expect(registerAutomationRun('run-2', 'mission-2')).toBeNull();
    expect(cancelAutomationRun('run-2', 'other')).toBe('mission_mismatch');
    expect(control.signal.aborted).toBe(false);
    control.finish();
  });
});
