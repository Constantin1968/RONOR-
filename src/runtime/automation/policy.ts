import crypto from 'crypto';
import type { AutomationAction, ExecutionMandate } from './contracts';

export const DEFAULT_ALLOWED_ACTIONS: AutomationAction[] = [
  'read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local', 'prepare_draft_pr',
];
export const ALWAYS_DENIED_ACTIONS: AutomationAction[] = [
  'external_send', 'secrets_read', 'main_write', 'push', 'merge', 'release', 'deploy',
  'financial_action', 'destructive_action',
];

export function objectiveHash(objective: string): string {
  return crypto.createHash('sha256').update(objective.trim(), 'utf8').digest('hex');
}

export function validateMandate(
  mandate: ExecutionMandate,
  context: { objective: string; workspaceRoot: string; branch: string; now?: Date },
): { valid: boolean; reason: string | null } {
  if (mandate.issued_by !== 'merlin') return { valid: false, reason: 'issuer_not_architect' };
  if (!/^key_[a-f0-9]{12}$/.test(mandate.issued_by_key_id)) return { valid: false, reason: 'issuer_identity_invalid' };
  if (objectiveHash(context.objective) !== mandate.objective_hash) return { valid: false, reason: 'objective_mismatch' };
  if (context.workspaceRoot !== mandate.workspace_root) return { valid: false, reason: 'workspace_mismatch' };
  const branchAllowed = context.branch === mandate.branch_prefix ||
    (mandate.branch_prefix.endsWith('/') && context.branch.startsWith(mandate.branch_prefix));
  if (!branchAllowed) return { valid: false, reason: 'branch_outside_mandate' };
  const now = (context.now ?? new Date()).getTime();
  if (now < Date.parse(mandate.issued_at) || now >= Date.parse(mandate.expires_at)) {
    return { valid: false, reason: 'mandate_expired_or_not_yet_valid' };
  }
  if (mandate.max_cost_usd < 0 || mandate.max_runtime_minutes <= 0 || mandate.max_fix_cycles < 0) {
    return { valid: false, reason: 'invalid_limits' };
  }
  if (mandate.allowed_actions.some((a) => ALWAYS_DENIED_ACTIONS.includes(a))) {
    return { valid: false, reason: 'consequential_action_cannot_be_delegated' };
  }
  return { valid: true, reason: null };
}

export function actionPermitted(mandate: ExecutionMandate, action: AutomationAction): boolean {
  if (ALWAYS_DENIED_ACTIONS.includes(action)) return false;
  return mandate.allowed_actions.includes(action) && !mandate.denied_actions.includes(action);
}
