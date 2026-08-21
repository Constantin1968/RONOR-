import type { AutomationAction } from './contracts';

export interface EffectDecision { allowed: boolean; reason: string; }

function strings(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 8 || output.length > 500) return output;
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, output, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) strings(item, output, depth + 1);
  return output;
}

/** Evaluate pending OpenHands actions, never observations or model prose. */
export function evaluateOpenHandsEffects(events: unknown, allowedActions: AutomationAction[]): EffectDecision {
  const record = events && typeof events === 'object' ? events as Record<string, unknown> : {};
  const items = Array.isArray(record.items) ? record.items : Array.isArray(events) ? events : [];
  const actions = items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const event = item as Record<string, unknown>;
    const kind = String(event.kind ?? event.type ?? '').toLowerCase();
    return kind.includes('action') && !kind.includes('observation');
  });
  if (actions.length < 1) return { allowed: false, reason: 'pending_action_missing' };
  const text = strings(actions).join('\n');
  if (text.length > 128_000) return { allowed: false, reason: 'pending_action_oversized' };

  const checks: Array<[RegExp, string]> = [
    [/\bgit\s+(?:-\S+\s+)*push\b/i, 'git_push_forbidden'],
    [/\bgit\s+remote\s+(?:add|set-url|rename|remove)\b/i, 'git_remote_mutation_forbidden'],
    [/(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)/i, 'cloud_metadata_forbidden'],
    [/(?:https?:\/\/)?(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i, 'private_network_forbidden'],
    [/(?:^|[\s"'=:])(?:\.\.\/|\.\.\\|~\/|\/etc(?:\/|\b)|\/root(?:\/|\b)|\/home(?:\/|\b)|\/var\/run(?:\/|\b)|[A-Za-z]:\\)/im, 'workspace_escape_forbidden'],
    [/\b(?:curl|wget|ftp|sftp|scp|ssh|nc|ncat|telnet|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'network_client_forbidden'],
    [/\b(?:sudo|su)\b/i, 'privilege_escalation_forbidden'],
    [/\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff)\b/i, 'destructive_command_forbidden'],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(text)) return { allowed: false, reason };
  if (allowedActions.some((action) => ['external_send', 'secrets_read', 'main_write', 'push', 'merge', 'release', 'deploy', 'financial_action', 'destructive_action'].includes(action))) {
    return { allowed: false, reason: 'consequential_capability_forbidden' };
  }
  if (!allowedActions.some((action) => ['read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local', 'prepare_draft_pr'].includes(action))) {
    return { allowed: false, reason: 'no_effect_capability' };
  }
  return { allowed: true, reason: 'within_isolated_mandate' };
}
