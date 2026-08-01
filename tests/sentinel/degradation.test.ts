/**
 * R-Sentinel — Degradation Ladder Tests (MIP-013)
 *
 * Verifies ladder ordering, the reversibility invariant, severity-to-level
 * mapping, and the configuration policy gate.
 */

import {
  DEGRADATION_LADDER,
  ResponseController,
  targetLevelFor,
} from '../../src/sentinel/response-controller';
import type { AlertSeverity } from '../../src/planes/r-sentinel/types';

describe('R-Sentinel · Degradation ladder structure', () => {
  test('contains exactly eight steps', () => {
    expect(DEGRADATION_LADDER).toHaveLength(8);
  });

  test('levels are contiguous and strictly ascending from 1 to 8', () => {
    DEGRADATION_LADDER.forEach((step, index) => {
      expect(step.level).toBe(index + 1);
    });
  });

  test('every step is reversible — the core Sentinel invariant', () => {
    for (const step of DEGRADATION_LADDER) {
      expect(step.reversible).toBe(true);
    }
  });

  test('step identifiers and descriptions are unique and non-empty', () => {
    const ids = DEGRADATION_LADDER.map((s) => s.id);
    const descriptions = DEGRADATION_LADDER.map((s) => s.description);
    expect(new Set(ids).size).toBe(8);
    expect(new Set(descriptions).size).toBe(8);
    ids.forEach((id) => expect(id.length).toBeGreaterThan(0));
  });

  test('trigger severities never regress as the ladder ascends', () => {
    const rank: Record<AlertSeverity, number> = {
      GREEN: 0,
      YELLOW: 1,
      ORANGE: 2,
      RED: 3,
      BLACK: 4,
    };
    for (let i = 1; i < DEGRADATION_LADDER.length; i++) {
      expect(rank[DEGRADATION_LADDER[i].triggerSeverity]).toBeGreaterThanOrEqual(
        rank[DEGRADATION_LADDER[i - 1].triggerSeverity]
      );
    }
  });

  test('the most severe step is reserved for BLACK', () => {
    expect(DEGRADATION_LADDER[7].triggerSeverity).toBe('BLACK');
    expect(DEGRADATION_LADDER[7].id).toBe('freeze-admissions-drain');
  });

  test('severity maps onto the expected ladder ceiling', () => {
    expect(targetLevelFor('GREEN')).toBe(0);
    expect(targetLevelFor('YELLOW')).toBe(2);
    expect(targetLevelFor('ORANGE')).toBe(5);
    expect(targetLevelFor('RED')).toBe(7);
    expect(targetLevelFor('BLACK')).toBe(8);
  });
});

describe('R-Sentinel · Response controller (authorised)', () => {
  let controller: ResponseController;

  beforeEach(() => {
    controller = new ResponseController({ degradationEnabled: true, maxLevel: 8 });
  });

  test('starts at level 0 with an empty history', () => {
    expect(controller.level).toBe(0);
    expect(controller.getHistory()).toHaveLength(0);
    expect(controller.getActiveSteps()).toHaveLength(0);
  });

  test('climbs the ladder in ascending order without skipping steps', () => {
    const actions = controller.reconcile('ORANGE');
    expect(actions.map((a) => a.step.level)).toEqual([1, 2, 3, 4, 5]);
    expect(actions.every((a) => a.applied)).toBe(true);
    expect(controller.level).toBe(5);
  });

  test('BLACK engages the full ladder', () => {
    const actions = controller.reconcile('BLACK');
    expect(actions).toHaveLength(8);
    expect(controller.level).toBe(8);
    expect(controller.getActiveSteps().map((s) => s.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('unwinds in exact reverse order as pressure falls', () => {
    controller.reconcile('BLACK');
    const reversed = controller.reconcile('YELLOW');
    expect(reversed.map((a) => a.step.level)).toEqual([8, 7, 6, 5, 4, 3]);
    expect(reversed.every((a) => a.applied === false)).toBe(true);
    expect(controller.level).toBe(2);
  });

  test('restoreAll returns the controller to nominal', () => {
    controller.reconcile('RED');
    expect(controller.level).toBe(7);
    const restored = controller.restoreAll();
    expect(restored.map((a) => a.step.level)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(controller.level).toBe(0);
    expect(controller.getActiveSteps()).toHaveLength(0);
  });

  test('reconciling to an unchanged severity is a no-op', () => {
    controller.reconcile('ORANGE');
    expect(controller.reconcile('ORANGE')).toHaveLength(0);
    expect(controller.level).toBe(5);
  });

  test('every decision, including reversals, is recorded in history', () => {
    controller.reconcile('RED');
    controller.reconcile('GREEN');
    const history = controller.getHistory();
    expect(history).toHaveLength(14); // 7 applied + 7 reversed
    history.forEach((action) => {
      expect(action.reason.length).toBeGreaterThan(0);
      expect(action.timestamp instanceof Date).toBe(true);
      expect(action.step.reversible).toBe(true);
    });
  });

  test('reset clears level and history', () => {
    controller.reconcile('BLACK');
    controller.reset();
    expect(controller.level).toBe(0);
    expect(controller.getHistory()).toHaveLength(0);
  });
});

describe('R-Sentinel · Policy gating', () => {
  test('unauthorised controllers stop at the last self-authorising step', () => {
    const controller = new ResponseController({ degradationEnabled: false });
    const actions = controller.reconcile('BLACK');
    const applied = actions.filter((a) => a.applied);
    const withheld = actions.filter((a) => !a.applied);

    expect(applied.map((a) => a.step.level)).toEqual([1, 2]);
    expect(controller.level).toBe(2);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].step.level).toBe(3);
    expect(withheld[0].reason).toContain('requires authorisation');
    expect(controller.policyAuthorised).toBe(false);
  });

  test('maxLevel caps the ladder even when fully authorised', () => {
    const controller = new ResponseController({ degradationEnabled: true, maxLevel: 4 });
    const actions = controller.reconcile('BLACK');
    expect(actions.map((a) => a.step.level)).toEqual([1, 2, 3, 4]);
    expect(controller.level).toBe(4);
  });

  test('maxLevel 0 disables degradation entirely', () => {
    const controller = new ResponseController({ degradationEnabled: true, maxLevel: 0 });
    expect(controller.reconcile('BLACK')).toHaveLength(0);
    expect(controller.level).toBe(0);
  });

  test('steps requiring authorisation are exactly levels 3 to 8', () => {
    const gated = DEGRADATION_LADDER.filter((s) => s.requiresAuthorisation).map((s) => s.level);
    expect(gated).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
