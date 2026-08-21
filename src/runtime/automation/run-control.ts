interface ActiveRun { missionId: string; controller: AbortController; }
const active = new Map<string, ActiveRun>();

export function registerAutomationRun(runId: string, missionId: string): { signal: AbortSignal; abort(): void; finish(): void } | null {
  if (active.has(runId)) return null;
  const controller = new AbortController();
  active.set(runId, { missionId, controller });
  return { signal: controller.signal, abort: () => controller.abort(), finish: () => { active.delete(runId); } };
}

export function cancelAutomationRun(runId: string, missionId: string): 'cancelled' | 'not_found' | 'mission_mismatch' {
  const run = active.get(runId);
  if (!run) return 'not_found';
  if (run.missionId !== missionId) return 'mission_mismatch';
  run.controller.abort();
  return 'cancelled';
}
