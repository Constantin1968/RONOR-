export const AUTOMATION_ACTIONS = [
  'read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local', 'prepare_draft_pr',
  'external_send', 'secrets_read', 'main_write', 'push', 'merge', 'release', 'deploy',
  'financial_action', 'destructive_action',
] as const;

export type AutomationAction = typeof AUTOMATION_ACTIONS[number];

export function isAutomationAction(value: unknown): value is AutomationAction {
  return typeof value === 'string' && (AUTOMATION_ACTIONS as readonly string[]).includes(value);
}

export interface ExecutionMandate {
  mandate_id: string;
  mission_id: string;
  issued_by: 'merlin';
  objective_hash: string;
  workspace_root: string;
  branch_prefix: string;
  allowed_actions: AutomationAction[];
  denied_actions: AutomationAction[];
  max_cost_usd: number;
  max_runtime_minutes: number;
  max_fix_cycles: number;
  issued_at: string;
  expires_at: string;
}

export interface PlannedAssignment { id: string; instruction: string; actions: AutomationAction[]; }
export interface AdapterResult { ok: boolean; summary: string; evidence: string[]; cost_usd: number; }
export interface VerificationVerdict extends AdapterResult { verdict: 'pass' | 'fail'; }

export interface AutomationAdapters {
  langgraph: { plan(objective: string): Promise<PlannedAssignment[]> };
  openhands: { execute(assignment: PlannedAssignment, mandate: ExecutionMandate): Promise<AdapterResult> };
  codex: { verify(missionId: string, evidence: string[]): Promise<VerificationVerdict> };
  assurance: { accept(missionId: string, verdict: VerificationVerdict): Promise<VerificationVerdict> };
}

export type AutomationRunStatus =
  | 'planned' | 'executing' | 'verifying' | 'assuring' | 'complete' | 'blocked' | 'failed';

export interface AutomationRun {
  run_id: string;
  mission_id: string;
  status: AutomationRunStatus;
  cost_usd: number;
  completed_assignments: number;
  total_assignments: number;
  reason: string | null;
}
