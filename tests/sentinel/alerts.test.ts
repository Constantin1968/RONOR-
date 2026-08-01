/**
 * R-Sentinel — Alert Engine Tests (MIP-013)
 *
 * Verifies the five-band severity ladder, the three-breach hysteresis rule,
 * alert payload completeness, and deterministic audit identifiers.
 */

import {
  AlertEngine,
  DEFAULT_HYSTERESIS_BREACHES,
  computeAuditRecordId,
  evaluateSeverity,
  recommendedActionFor,
} from '../../src/sentinel/alert-engine';
import { MetricRingBuffer, RingBuffer } from '../../src/sentinel/ring-buffer';
import { SEVERITY_RANK } from '../../src/planes/r-sentinel/types';
import type { AlertSeverity, ResourceMetric } from '../../src/planes/r-sentinel/types';

function metric(utilisation: number, offsetMs = 0): ResourceMetric {
  return {
    name: 'ram.utilisation',
    value: utilisation,
    unit: 'percent',
    timestamp: new Date(1_700_000_000_000 + offsetMs),
    resource: 'ram',
    utilisationPercent: utilisation,
    capacity: 100,
    collector: 'system',
    available: true,
  };
}

describe('R-Sentinel · Threshold evaluation', () => {
  test.each<[number, AlertSeverity]>([
    [0, 'GREEN'],
    [42, 'GREEN'],
    [69.99, 'GREEN'],
    [70, 'YELLOW'],
    [84.99, 'YELLOW'],
    [85, 'ORANGE'],
    [94.99, 'ORANGE'],
    [95, 'RED'],
    [98.99, 'RED'],
    [99, 'BLACK'],
    [100, 'BLACK'],
  ])('%p%% utilisation classifies as %s', (utilisation, expected) => {
    expect(evaluateSeverity(utilisation)).toBe(expected);
  });

  test('non-finite input degrades to GREEN rather than throwing', () => {
    expect(evaluateSeverity(Number.NaN)).toBe('GREEN');
    expect(evaluateSeverity(Number.POSITIVE_INFINITY)).toBe('GREEN');
    expect(evaluateSeverity(Number.NEGATIVE_INFINITY)).toBe('GREEN');
  });

  test('band boundaries are strictly monotonic', () => {
    const bands: AlertSeverity[] = ['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK'];
    for (let i = 1; i < bands.length; i++) {
      expect(SEVERITY_RANK[bands[i]]).toBeGreaterThan(SEVERITY_RANK[bands[i - 1]]);
    }
  });

  test('each band carries a distinct recommended action', () => {
    const actions = (['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK'] as AlertSeverity[]).map((s) =>
      recommendedActionFor(s, 'ram')
    );
    expect(new Set(actions).size).toBe(5);
  });
});

describe('R-Sentinel · Hysteresis', () => {
  let engine: AlertEngine;

  beforeEach(() => {
    engine = new AlertEngine({ hysteresisBreaches: 3 });
  });

  test('default hysteresis requires three consecutive breaches', () => {
    expect(new AlertEngine().breachesRequired).toBe(DEFAULT_HYSTERESIS_BREACHES);
  });

  test('no alert is emitted before the third consecutive breach', () => {
    expect(engine.evaluate(metric(88, 0))).toBeNull();
    expect(engine.evaluate(metric(89, 5_000))).toBeNull();
    const alert = engine.evaluate(metric(90, 10_000));
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe('ORANGE');
    expect(alert!.consecutiveBreaches).toBe(3);
  });

  test('a transient spike is suppressed entirely', () => {
    expect(engine.evaluate(metric(96, 0))).toBeNull();
    expect(engine.evaluate(metric(40, 5_000))).toBeNull();
    expect(engine.evaluate(metric(41, 10_000))).toBeNull();
    expect(engine.getActiveAlerts()).toHaveLength(0);
    expect(engine.aggregateSeverity()).toBe('GREEN');
  });

  test('an interrupted breach run resets the counter', () => {
    engine.evaluate(metric(90, 0));
    engine.evaluate(metric(91, 5_000));
    engine.evaluate(metric(50, 10_000)); // interruption
    engine.evaluate(metric(90, 15_000));
    engine.evaluate(metric(91, 20_000));
    expect(engine.getActiveAlerts()).toHaveLength(0);
    const alert = engine.evaluate(metric(92, 25_000));
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe('ORANGE');
  });

  test('a sustained band emits exactly one alert, not one per poll', () => {
    for (let i = 0; i < 10; i++) engine.evaluate(metric(96, i * 5_000));
    expect(engine.totalAlertsEmitted).toBe(1);
    expect(engine.getActiveAlerts()).toHaveLength(1);
    expect(engine.getActiveAlerts()[0].severity).toBe('RED');
  });

  test('escalation between bands requires its own three confirmations', () => {
    for (let i = 0; i < 3; i++) engine.evaluate(metric(90, i * 5_000));
    expect(engine.severityFor('ram.utilisation')).toBe('ORANGE');

    expect(engine.evaluate(metric(96, 15_000))).toBeNull();
    expect(engine.evaluate(metric(96, 20_000))).toBeNull();
    const escalated = engine.evaluate(metric(97, 25_000));
    expect(escalated).not.toBeNull();
    expect(escalated!.severity).toBe('RED');
    expect(escalated!.previousSeverity).toBe('ORANGE');
  });

  test('recovery to GREEN clears the alert after three confirmations', () => {
    for (let i = 0; i < 3; i++) engine.evaluate(metric(96, i * 5_000));
    expect(engine.getActiveAlerts()).toHaveLength(1);

    engine.evaluate(metric(30, 15_000));
    engine.evaluate(metric(31, 20_000));
    expect(engine.getActiveAlerts()).toHaveLength(1); // not yet cleared
    engine.evaluate(metric(32, 25_000));
    expect(engine.getActiveAlerts()).toHaveLength(0);
    expect(engine.aggregateSeverity()).toBe('GREEN');
  });

  test('unavailable probes never raise alerts', () => {
    for (let i = 0; i < 5; i++) {
      engine.evaluate({ ...metric(100, i * 5_000), available: false });
    }
    expect(engine.getActiveAlerts()).toHaveLength(0);
  });
});

describe('R-Sentinel · Alert payloads', () => {
  test('alert carries a complete, audit-ready payload', () => {
    const engine = new AlertEngine({ hysteresisBreaches: 3 });
    let alert = null;
    for (let i = 0; i < 3; i++) alert = engine.evaluate(metric(96.5, i * 5_000));

    expect(alert).not.toBeNull();
    expect(alert!.resource).toBe('ram');
    expect(alert!.severity).toBe('RED');
    expect(alert!.currentUtilisation).toBeCloseTo(96.5, 2);
    expect(alert!.remainingCapacity).toBeCloseTo(3.5, 2);
    expect(alert!.cause).toContain('ram');
    expect(alert!.recommendedAction.length).toBeGreaterThan(10);
    expect(alert!.timestamp instanceof Date).toBe(true);
    expect(alert!.auditRecordId).toMatch(/^sentinel-[0-9a-f]{32}$/);
    expect(alert!.estimatedExhaustion).toBeNull();
  });

  test('audit record ids are deterministic and collision-resistant', () => {
    const ts = new Date(1_700_000_000_000);
    const a = computeAuditRecordId('ram', 'RED', 96.5, ts);
    const b = computeAuditRecordId('ram', 'RED', 96.5, ts);
    const c = computeAuditRecordId('cpu', 'RED', 96.5, ts);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('exhaustion estimator is wired through when supplied', () => {
    const exhaustsAt = new Date(1_700_000_600_000);
    const engine = new AlertEngine({ hysteresisBreaches: 3, exhaustionEstimator: () => exhaustsAt });
    let alert = null;
    for (let i = 0; i < 3; i++) alert = engine.evaluate(metric(96, i * 5_000));
    expect(alert!.estimatedExhaustion).toEqual(exhaustsAt);
  });

  test('aggregate severity reflects the worst confirmed series', () => {
    const engine = new AlertEngine({ hysteresisBreaches: 3 });
    const cpu = (u: number, o: number): ResourceMetric => ({
      ...metric(u, o),
      name: 'cpu.utilisation',
      resource: 'cpu',
    });

    for (let i = 0; i < 3; i++) {
      engine.evaluate(metric(72, i * 5_000)); // YELLOW
      engine.evaluate(cpu(99.5, i * 5_000)); // BLACK
    }
    expect(engine.aggregateSeverity()).toBe('BLACK');
    expect(engine.getActiveAlerts()[0].severity).toBe('BLACK'); // sorted worst-first
  });

  test('reset clears all state', () => {
    const engine = new AlertEngine({ hysteresisBreaches: 3 });
    for (let i = 0; i < 3; i++) engine.evaluate(metric(96, i * 5_000));
    engine.reset();
    expect(engine.getActiveAlerts()).toHaveLength(0);
    expect(engine.totalAlertsEmitted).toBe(0);
    expect(engine.aggregateSeverity()).toBe('GREEN');
  });
});

describe('R-Sentinel · Ring buffer', () => {
  test('generic buffer overwrites oldest entries and never grows', () => {
    const buffer = new RingBuffer<number>(5);
    for (let i = 1; i <= 12; i++) buffer.push(i);
    expect(buffer.length).toBe(5);
    expect(buffer.capacity).toBe(5);
    expect(buffer.isFull).toBe(true);
    expect(buffer.toArray()).toEqual([8, 9, 10, 11, 12]);
    expect(buffer.last(2)).toEqual([11, 12]);
  });

  test('generic buffer rejects an invalid capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
  });

  test('metric buffer sizes each series to the retention window', () => {
    const buffer = new MetricRingBuffer(5 * 60 * 1000, 5_000);
    expect(buffer.capacityPerSeries).toBe(60);
  });

  test('metric buffer keeps series independent and bounded', () => {
    const buffer = new MetricRingBuffer(60_000, 5_000); // 12 samples/series
    for (let i = 0; i < 40; i++) {
      buffer.record(metric(50 + i, i * 5_000));
      buffer.record({ ...metric(10, i * 5_000), name: 'cpu.utilisation', resource: 'cpu' });
    }
    expect(buffer.names().sort()).toEqual(['cpu.utilisation', 'ram.utilisation']);
    expect(buffer.get('ram.utilisation')).toHaveLength(12);
    expect(buffer.totalSamples).toBe(24);
    expect(buffer.latest('ram.utilisation')!.value).toBe(89);
    expect(buffer.latestAll()).toHaveLength(2);
  });
});
