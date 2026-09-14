import { evaluateOpenHandsEffects, type EffectDecision } from './effect-policy';
import type { AutomationAction } from './contracts';

/** Match SDK 1.42.1 get_unmatched_actions(state.active_branch()), not a suffix
 * ending at an arbitrary observation. Callers collect bounded descending pages
 * until the active branch reaches its root. Unrelated branches never authorize
 * actions. An incomplete chain, duplicate identity or cycle fails closed. */
export function evaluatePendingOpenHandsActions(
  state: Record<string, unknown>, page: Record<string, unknown>, allowed: AutomationAction[],
): EffectDecision {
  if (state.execution_status !== 'waiting_for_confirmation' ||
      typeof state.leaf_event_id !== 'string' || !state.leaf_event_id) {
    return { allowed: false, reason: 'pending_state_anchor_missing' };
  }
  if (!Array.isArray(page.items) || page.items.length > 3200) {
    return { allowed: false, reason: 'pending_page_invalid' };
  }
  const items = page.items as Record<string, unknown>[];
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of items) {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.id !== 'string' || !event.id || byId.has(event.id)) {
      return { allowed: false, reason: 'pending_page_invalid' };
    }
    byId.set(event.id, event);
  }
  if (!byId.has(state.leaf_event_id)) return { allowed: false, reason: 'pending_state_anchor_mismatch' };
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let id: string | null = state.leaf_event_id;
  while (id !== null) {
    if (visited.has(id)) return { allowed: false, reason: 'pending_branch_invalid' };
    visited.add(id);
    const event = byId.get(id);
    if (!event) return { allowed: false, reason: 'pending_branch_incomplete' };
    if (event.kind === 'ConversationStateUpdateEvent' ||
        (event.parent_id !== undefined && event.parent_id !== null &&
          (typeof event.parent_id !== 'string' || !event.parent_id))) {
      return { allowed: false, reason: 'pending_branch_invalid' };
    }
    branch.push(event);
    // The native JSON serializer excludes None, so an omitted parent is root.
    id = typeof event.parent_id === 'string' ? event.parent_id : null;
  }
  const observedIds = new Set<string>();
  const observedCalls = new Set<string>();
  const actions: Record<string, unknown>[] = [];
  for (const event of branch) {
    if (event.kind === 'ObservationEvent' || event.kind === 'UserRejectObservation') {
      if (typeof event.action_id !== 'string' || !event.action_id) {
        return { allowed: false, reason: 'pending_observation_invalid' };
      }
      observedIds.add(event.action_id);
    } else if (event.kind === 'AgentErrorEvent') {
      if (typeof event.tool_call_id !== 'string' || !event.tool_call_id) {
        return { allowed: false, reason: 'pending_observation_invalid' };
      }
      observedCalls.add(event.tool_call_id);
    } else if (event.kind === 'ActionEvent') {
      // SDK ignores non-executable actions (including failed validation). None
      // is omitted by the native serializer; neither form can be confirmed.
      if (event.action == null) continue;
      if (typeof event.action !== 'object' || Array.isArray(event.action)) {
        return { allowed: false, reason: 'pending_action_invalid' };
      }
      if (!observedIds.has(String(event.id)) && !observedCalls.has(String(event.tool_call_id))) {
        actions.push({ kind: 'ActionEvent', action: event.action });
      }
    }
  }
  // The legacy policy's string walker has a finite depth/node budget. Never
  // silently authorize an action whose executable fields could be truncated.
  for (const action of actions) {
    let nodes = 0;
    const bounded = (value: unknown, depth = 0): boolean => {
      nodes += 1;
      if (nodes > 256 || depth > 5) return false;
      return !value || typeof value !== 'object' || Object.values(value).every(v => bounded(v, depth + 1));
    };
    if (!bounded(action.action)) return { allowed:false, reason:'pending_action_oversized' };
    const decision = evaluateOpenHandsEffects({items:[action]}, allowed);
    if (!decision.allowed) return decision;
  }
  return actions.length ? {allowed:true, reason:'within_isolated_mandate'}
    : {allowed:false, reason:'pending_action_missing'};
}
