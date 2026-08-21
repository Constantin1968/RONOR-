import type { AutomationRun, AutomationRunStatus } from './contracts';

export interface BackgroundRunLease {
  finish(status: AutomationRunStatus): boolean;
}

export interface BackgroundRunControl {
  finish(): void;
}

/** Detach execution from HTTP while retaining lease and cancellation control. */
export function launchAutomationRun(params: {
  execute(): Promise<AutomationRun>;
  lease: BackgroundRunLease;
  control: BackgroundRunControl;
  onUnhandledFailure(): void;
}): void {
  queueMicrotask(() => {
    void (async () => {
      let status: AutomationRunStatus = 'failed';
      try {
        status = (await params.execute()).status;
      } catch {
        // Error details are intentionally discarded at this trust boundary.
        params.onUnhandledFailure();
      } finally {
        params.lease.finish(status);
        params.control.finish();
      }
    })();
  });
}
