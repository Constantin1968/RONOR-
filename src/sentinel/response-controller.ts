/**
 * R-Sentinel — Response Controller
 * MIP-013
 *
 * Owns the graceful degradation ladder: eight ordered, individually reversible
 * steps that trade capability for survival as pressure rises, and are unwound
 * in exact reverse order as pressure falls.
 *
 * Two invariants are enforced by construction and verified by tests:
 *   1. Every step is reversible — the Sentinel plane never takes an action it
 *      cannot undo without operator intervention.
 *   2. Every step is policy-gated — nothing executes unless configuration
 *      authorises it (`SENTINEL_DEGRADATION_ENABLED`) and the step's level is
 *      within `SENTINEL_MAX_DEGRADATION_LEVEL`.
 */

import { createLogger } from '../utils/logger';
import { SEVERITY_RANK } from '../planes/r-sentinel/types';
import type {
  AlertSeverity,
  DegradationAction,
  DegradationStep,
} from '../planes/r-sentinel/types';

const logger = createLogger('Sentinel:ResponseController');

/**
 * The ladder. Ordered 1 → 8 from least to most disruptive. Levels 1–2 are
 * self-authorising housekeeping; levels 3–8 require explicit configuration
 * authorisation because they are user-visible.
 */
export const DEGRADATION_LADDER: readonly DegradationStep[] = [
  {
    level: 1,
    id: 'trim-metric-retention',
    description: 'Trim Sentinel metric retention to the minimum viable window.',
    triggerSeverity: 'YELLOW',
    reversible: true,
    requiresAuthorisation: false,
  },
  {
    level: 2,
    id: 'flush-context-caches',
    description: 'Flush warm context caches and compressed-context scratch space.',
    triggerSeverity: 'YELLOW',
    reversible: true,
    requiresAuthorisation: false,
  },
  {
    level: 3,
    id: 'defer-batch-work',
    description: 'Defer non-interactive batch and background evaluation work.',
    triggerSeverity: 'ORANGE',
    reversible: true,
    requiresAuthorisation: true,
  },
  {
    level: 4,
    id: 'reduce-context-window',
    description: 'Reduce the effective context window and raise the compression threshold.',
    triggerSeverity: 'ORANGE',
    reversible: true,
    requiresAuthorisation: true,
  },
  {
    level: 5,
    id: 'route-to-lighter-models',
    description: 'Bias R-Model Fabric routing towards lower-cost, lower-footprint models.',
    triggerSeverity: 'ORANGE',
    reversible: true,
    requiresAuthorisation: true,
  },
  {
    level: 6,
    id: 'reduce-agent-concurrency',
    description: 'Reduce R-Agent Runtime concurrency and maximum iteration budget.',
    triggerSeverity: 'RED',
    reversible: true,
    requiresAuthorisation: true,
  },
  {
    level: 7,
    id: 'throttle-admissions',
    description: 'Throttle R-Gateway admissions — queue new sessions instead of accepting them.',
    triggerSeverity: 'RED',
    reversible: true,
    requiresAuthorisation: true,
  },
  {
    level: 8,
    id: 'freeze-admissions-drain',
    description: 'Freeze admissions entirely, drain in-flight work, and escalate to the operator.',
    triggerSeverity: 'BLACK',
    reversible: true,
    requiresAuthorisation: true,
  },
] as const;

/** Highest ladder level eligible for a given severity band. */
export function targetLevelFor(severity: AlertSeverity): number {
  let target = 0;
  for (const step of DEGRADATION_LADDER) {
    if (SEVERITY_RANK[severity] >= SEVERITY_RANK[step.triggerSeverity]) target = step.level;
  }
  return target;
}

export interface ResponseControllerOptions {
  /** Master policy gate. */
  degradationEnabled?: boolean;
  /** Ceiling on ladder level, 0–8. */
  maxLevel?: number;
}

export class ResponseController {
  private readonly degradationEnabled: boolean;
  private readonly maxLevel: number;
  private currentLevel = 0;
  private readonly history: DegradationAction[] = [];

  constructor(options: ResponseControllerOptions = {}) {
    this.degradationEnabled =
      options.degradationEnabled ?? process.env.SENTINEL_DEGRADATION_ENABLED === 'true';
    const configuredMax =
      options.maxLevel ?? parseInt(process.env.SENTINEL_MAX_DEGRADATION_LEVEL || '8', 10);
    this.maxLevel = Number.isFinite(configuredMax)
      ? Math.max(0, Math.min(DEGRADATION_LADDER.length, configuredMax))
      : DEGRADATION_LADDER.length;
  }

  get level(): number {
    return this.currentLevel;
  }

  get policyAuthorised(): boolean {
    return this.degradationEnabled;
  }

  get ladder(): readonly DegradationStep[] {
    return DEGRADATION_LADDER;
  }

  getHistory(): DegradationAction[] {
    return [...this.history];
  }

  /** Steps currently applied, in ascending ladder order. */
  getActiveSteps(): DegradationStep[] {
    return DEGRADATION_LADDER.filter((step) => step.level <= this.currentLevel);
  }

  /**
   * Reconcile the ladder against a severity band: climb towards the target
   * level, or unwind (in reverse order) when pressure falls. Every decision is
   * recorded, including refusals, so the audit trail explains inaction too.
   */
  reconcile(severity: AlertSeverity, now: Date = new Date()): DegradationAction[] {
    const desired = Math.min(targetLevelFor(severity), this.maxLevel);
    const actions: DegradationAction[] = [];

    if (desired > this.currentLevel) {
      for (let level = this.currentLevel + 1; level <= desired; level++) {
        const step = DEGRADATION_LADDER[level - 1];
        const authorised = !step.requiresAuthorisation || this.degradationEnabled;
        if (!authorised) {
          actions.push({
            step,
            applied: false,
            reason: `Withheld: step requires authorisation but SENTINEL_DEGRADATION_ENABLED is not set (severity ${severity}).`,
            timestamp: now,
          });
          logger.warn(`Degradation step ${step.level} (${step.id}) withheld — not policy-authorised`);
          break;
        }
        this.currentLevel = level;
        actions.push({
          step,
          applied: true,
          reason: `Applied at severity ${severity}: ${step.description}`,
          timestamp: now,
        });
        logger.info(`Degradation step ${step.level} (${step.id}) applied — severity ${severity}`);
      }
    } else if (desired < this.currentLevel) {
      for (let level = this.currentLevel; level > desired; level--) {
        const step = DEGRADATION_LADDER[level - 1];
        this.currentLevel = level - 1;
        actions.push({
          step,
          applied: false,
          reason: `Reversed at severity ${severity}: ${step.id} restored to nominal.`,
          timestamp: now,
        });
        logger.info(`Degradation step ${step.level} (${step.id}) reversed — severity ${severity}`);
      }
    }

    this.history.push(...actions);
    return actions;
  }

  /** Unwind the entire ladder in reverse order. */
  restoreAll(now: Date = new Date()): DegradationAction[] {
    return this.reconcile('GREEN', now);
  }

  reset(): void {
    this.currentLevel = 0;
    this.history.length = 0;
  }
}
