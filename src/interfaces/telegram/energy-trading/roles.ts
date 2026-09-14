/**
 * RONOR — L0 · Telegram · Energy Trading · Role Model
 * ────────────────────────────────────────────────────
 * Role-based access for the crossborder trading commands. A user reaching the
 * bridge must clear TWO gates before any trading command runs:
 *
 *   1. The outer allowlist (TELEGRAM_ALLOWED_USER_IDS) — the bridge already
 *      enforces this before any command is dispatched. Nothing in this file
 *      relaxes it.
 *
 *   2. A role assignment in TELEGRAM_ROLE_MAP. A user who is on the allowlist
 *      but NOT in the role map is denied every trading command. They keep
 *      access to the general RONOR commands the bot already gives them, but
 *      the trading surface stays closed.
 *
 * Roles recognised
 *   ma11ai:sovereign         — every trading command; co-signs consequential trades.
 *   nrgpaths:trading_trainer — initiate any trade request (no cap); uploads,
 *                              feedback, corrections; view reports. Cannot
 *                              settle a trade without a sovereign co-sign.
 *   encon:trading_observer   — read-only trading reports and briefs.
 *
 * Any other role string in the map is treated as unrecognised — the user is
 * refused every trading command, and a warning is logged at boot. This is a
 * deliberate fail-closed choice: a typo in a role name that silently promotes
 * a user to sovereign is exactly the failure mode the map is meant to prevent.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../../utils/logger';

const logger = createLogger('RONOR:Telegram:EnergyTrading:Roles');

export type TradingNamespace = 'ma11ai' | 'nrgpaths' | 'encon';
export type TradingRole =
  | 'sovereign'
  | 'trading_trainer'
  | 'trading_observer';

export interface RoleAssignment {
  namespace: TradingNamespace;
  role: TradingRole;
}

const KNOWN_NAMESPACES: ReadonlySet<string> = new Set(['ma11ai', 'nrgpaths', 'encon']);
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'sovereign',
  'trading_trainer',
  'trading_observer',
]);

// ---------------------------------------------------------------------------
// Command taxonomy
// ---------------------------------------------------------------------------
//
// Every trading command falls into exactly one of these buckets. The bucket
// dictates which roles can invoke it. Adding a new command means adding it to
// exactly one bucket — the switch below then decides authorisation with no
// further changes elsewhere.

export type TradingCommandBucket =
  | 'read'          // /energy_status, /energy_report, /day, /pl, /brief
  | 'contribute'    // /upload_case, /feedback, /correct
  | 'initiate'      // /trade_request (starts a gated trade)
  | 'settle'        // /approve, /reject when the pending is a trade
  | 'sovereign_only'; // (reserved) commands that ONLY the sovereign may issue

/**
 * Map a trading command to its bucket. Commands not returned here are not
 * trading commands and must not be dispatched through this authoriser.
 */
export function tradingBucketFor(command: string): TradingCommandBucket | null {
  switch (command) {
    case 'energy_status':
    case 'energy_report':
    case 'day':
    case 'pl':
    case 'brief':
      return 'read';
    case 'upload_case':
    case 'feedback':
    case 'correct':
      return 'contribute';
    case 'trade_request':
      return 'initiate';
    // /approve and /reject go through settle() rather than this map, because
    // whether they touch a TRADE pending or a general RONOR pending is decided
    // at the approval store, not at parse time.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class RoleMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleMapError';
  }
}

/**
 * Parse TELEGRAM_ROLE_MAP into a Map<userId, RoleAssignment>.
 *
 * Format:
 *   <user_id>:<namespace>:<role>,<user_id>:<namespace>:<role>,...
 *
 * Whitespace around each entry is tolerated. Empty input returns an empty map
 * (no users are role-authorised). Malformed entries are REJECTED, not skipped,
 * for the same reason the allowlist rejects malformed ids: a silently dropped
 * assignment gives you a role model that does not match the file it came from.
 */
export function parseRoleMap(raw: string | undefined): Map<number, RoleAssignment> {
  const out = new Map<number, RoleAssignment>();
  if (!raw || raw.trim().length === 0) return out;

  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const parts = entry.split(':');
    if (parts.length !== 3) {
      throw new RoleMapError(
        `TELEGRAM_ROLE_MAP entry '${entry}' is not in the form <user_id>:<namespace>:<role>. ` +
          "Example: '7200344419:ma11ai:sovereign'.",
      );
    }
    const [rawId, rawNs, rawRole] = parts.map((s) => s.trim());
    const userId = Number(rawId);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new RoleMapError(
        `TELEGRAM_ROLE_MAP entry '${entry}' has '${rawId}' where a numeric Telegram user id is required.`,
      );
    }
    if (!KNOWN_NAMESPACES.has(rawNs)) {
      throw new RoleMapError(
        `TELEGRAM_ROLE_MAP entry '${entry}' uses unknown namespace '${rawNs}'. ` +
          "Recognised: 'ma11ai', 'nrgpaths', 'encon'.",
      );
    }
    if (!KNOWN_ROLES.has(rawRole)) {
      throw new RoleMapError(
        `TELEGRAM_ROLE_MAP entry '${entry}' uses unknown role '${rawRole}'. ` +
          "Recognised: 'sovereign', 'trading_trainer', 'trading_observer'.",
      );
    }
    if (out.has(userId)) {
      throw new RoleMapError(
        `TELEGRAM_ROLE_MAP defines user ${userId} twice. Every user must map to exactly one role.`,
      );
    }
    out.set(userId, { namespace: rawNs as TradingNamespace, role: rawRole as TradingRole });
  }

  logger.info(`role map resolved: ${out.size} user(s) assigned`);
  return out;
}

// ---------------------------------------------------------------------------
// Authoriser
// ---------------------------------------------------------------------------

export interface AuthorisationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether the given user, holding the given role assignment (may be
 * undefined if the user has no role), may run a command in the given bucket.
 *
 * The rules:
 *
 *   read         : sovereign · trading_trainer · trading_observer
 *   contribute   : sovereign · trading_trainer
 *   initiate     : sovereign · trading_trainer   (trainer requests always
 *                                                  need a sovereign co-sign)
 *   settle       : sovereign only
 *   sovereign_only: sovereign only
 *
 * A user with no role assignment is refused every bucket — the trading
 * surface stays closed to any allowed user the operator has not explicitly
 * enrolled. This is the correct default: the bridge already gives them the
 * general RONOR commands, and adding them to the role map is one env-var
 * edit and a restart away.
 */
export function authoriseTradingCommand(
  bucket: TradingCommandBucket,
  assignment: RoleAssignment | undefined,
): AuthorisationDecision {
  if (!assignment) {
    return {
      allowed: false,
      reason:
        'You have RONOR bridge access but no trading role. Ask the sovereign to add you ' +
        'to TELEGRAM_ROLE_MAP with the role appropriate to your mandate.',
    };
  }

  const { role } = assignment;

  switch (bucket) {
    case 'read':
      return { allowed: true };
    case 'contribute':
      if (role === 'sovereign' || role === 'trading_trainer') return { allowed: true };
      return {
        allowed: false,
        reason: 'Contributing cases, feedback or corrections requires the trading_trainer or sovereign role.',
      };
    case 'initiate':
      if (role === 'sovereign' || role === 'trading_trainer') return { allowed: true };
      return {
        allowed: false,
        reason: 'Initiating a trade request requires the trading_trainer or sovereign role.',
      };
    case 'settle':
    case 'sovereign_only':
      if (role === 'sovereign') return { allowed: true };
      return {
        allowed: false,
        reason: 'Only the sovereign role can settle a trade or issue this command.',
      };
    default: {
      // Exhaustiveness check: a new bucket added without extending this switch
      // becomes a compile-time error via `never`.
      const _exhaustive: never = bucket;
      return { allowed: false, reason: 'Unknown command bucket.' };
    }
  }
}

/**
 * Convenience: whether a specific user is authorised to co-sign a trade
 * pending. Trade co-sign is stricter than general RONOR co-sign: the user must
 * (a) be an approver in the base bridge config, (b) hold the sovereign role,
 * and (c) if TELEGRAM_TRADING_APPROVERS is set, be listed there too.
 */
export function isTradeCoSigner(
  userId: number,
  isBaseApprover: boolean,
  assignment: RoleAssignment | undefined,
  tradingApprovers: ReadonlySet<number>,
): boolean {
  if (!isBaseApprover) return false;
  if (!assignment || assignment.role !== 'sovereign') return false;
  if (tradingApprovers.size > 0 && !tradingApprovers.has(userId)) return false;
  return true;
}

/**
 * Human-readable summary of a role, used in onboarding and status.
 */
export function describeRole(assignment: RoleAssignment): string {
  return `${assignment.namespace}:${assignment.role}`;
}
