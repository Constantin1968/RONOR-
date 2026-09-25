/**
 * RONOR Operator — bucla OODA (schelet Tranșa 1, fără efecte laterale)
 * ────────────────────────────────────────────────────────────────────
 * observe → plan → approve → execute(gated) → verify → memorize.
 * Această versiune implementează doar POARTA (gating): validează mandatul,
 * bugetul, lease-ul pe resursă, acțiunea tipizată și tierul de aprobare.
 * NU execută nimic, NU atinge rețeaua, NU scrie pe disc.
 *
 * Tipurile permise vin NUMAI din mandat (`allowed_actions` minus
 * `denied_actions`, prin `operatorTypesFromMandate`). Apelantul nu poate lărgi
 * lista: nu există parametru pentru asta, iar un câmp `allowedOperatorTypes`
 * strecurat în parametri este ignorat.
 *
 * Tieruri: `ops.actuate` cere aprobare umană explicită (`approved=true`) și, în
 * vocabularul actual al mandatului, nu poate fi delegat deloc.
 */

import { validateMandate } from '../automation/policy';
import type { ExecutionMandate } from '../automation/contracts';
import {
  evaluateTypedOperatorAction,
  operatorTypesFromMandate,
  type OperatorActionType,
} from './actions';
import type { ResourceLeaseManager } from './resource-lease';

export type OperatorTickDecision =
  | { decision: 'ready_to_execute'; reason: 'operator_tick_permitted' }
  | { decision: 'blocked'; reason: string };

export interface OperatorTickParams {
  mandate: ExecutionMandate;
  /** Obiectivul în clar — comparat cu `objective_hash` din mandat. */
  objective: string;
  workspaceRoot: string;
  branch: string;
  /** Resursa fizică/logică: cale canonică arbore sau device id. */
  resource: string;
  owner: string;
  action: unknown;
  /**
   * Aprobare umană pentru `ops.actuate`. Deocamdată un simplu boolean,
   * nelegat de hash-ul acțiunii, de dispozitiv sau de o expirare (Tranșa 2).
   */
  approved: boolean;
  costSoFarUsd: number;
  leaseManager: ResourceLeaseManager;
  leaseMs?: number;
  now?: Date;
}

export function runOperatorTick(params: OperatorTickParams): OperatorTickDecision {
  const now = params.now ?? new Date();

  const validation = validateMandate(params.mandate, {
    objective: params.objective,
    workspaceRoot: params.workspaceRoot,
    branch: params.branch,
    now,
  });
  if (!validation.valid) return { decision: 'blocked', reason: `mandate_invalid:${validation.reason}` };

  if (!Number.isFinite(params.costSoFarUsd) || params.costSoFarUsd < 0)
    return { decision: 'blocked', reason: 'cost_invalid' };
  if (params.costSoFarUsd >= params.mandate.max_cost_usd)
    return { decision: 'blocked', reason: 'cost_budget_exhausted_before_execution' };
  if (now.getTime() >= Date.parse(params.mandate.expires_at))
    return { decision: 'blocked', reason: 'mandate_expired' };

  const claim = params.leaseManager.claim({
    resource: params.resource,
    owner: params.owner,
    leaseMs: params.leaseMs ?? 120_000,
    now,
  });
  if (claim.outcome === 'busy') return { decision: 'blocked', reason: `resource_busy:${claim.holder}` };

  const evaluation = evaluateTypedOperatorAction(params.action, operatorTypesFromMandate(params.mandate));
  if (!evaluation.allowed) {
    params.leaseManager.release({ resource: params.resource, owner: params.owner });
    return { decision: 'blocked', reason: evaluation.reason };
  }

  const type = (params.action as { type: OperatorActionType }).type;
  if (type === 'ops.actuate' && !params.approved) {
    params.leaseManager.release({ resource: params.resource, owner: params.owner });
    return { decision: 'blocked', reason: 'approval_required' };
  }

  return { decision: 'ready_to_execute', reason: 'operator_tick_permitted' };
}
