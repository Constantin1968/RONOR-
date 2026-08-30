/**
 * RONOR — Oglindirea lanțului de audit în baza de guvernanță suverană
 * ───────────────────────────────────────────────────────────────────
 * These tests target the properties that fail SILENTLY when wrong:
 *
 *   · a `decision_type` that leaves the constrained relational vocabulary is
 *     rejected by `audit_events_event_type_check` and the row disappears with a
 *     403/400 nobody reads;
 *   · a mirroring failure that propagates into `append()` would break the one
 *     register that is authoritative;
 *   · an `audit_chain_hash` that is not the link's `chain_hash` verbatim makes
 *     the two registers unreconcilable while looking populated;
 *   · a health endpoint that reports green while the relational register is
 *     unreachable is worse than no health endpoint.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  TIPURI_EVENIMENT_PERMISE,
  construiesteRandAudit,
  configureazaOglindire,
  esteTipEvenimentPermis,
  necesitaCosemnaturaUmana,
  oglindesteVeriga,
  programeazaOglindire,
  raporteazaPersistenta,
  reseteazaOglindire,
  stareOglindire,
  traduTipEveniment,
} from '../../src/persistence/audit-mirror';
import type { AuditPayload, AuditRecord } from '../../src/audit/hash-chain';

// ---------------------------------------------------------------------------
// Ajutoare
// ---------------------------------------------------------------------------

function sarcina(overrides: Partial<AuditPayload> = {}): AuditPayload {
  return {
    decisionId: 'dec-0001',
    decisionType: 'runtime.query.analysis',
    timestamp: '2026-08-30T04:00:00.000Z',
    context: {
      decisionId: 'dec-0001',
      domain: 'runtime.query.analysis',
      action: 'answer a governed query',
      proposedBy: 'deterministic',
      confidence: 0.9,
      reversible: true,
      impactMagnitude: { unit: 'other', value: 0 },
      sovereignty: { dataResidency: 'eu', subjectJurisdiction: 'RO' },
      evidence: { sourceCount: 2, lastRefreshMs: 1_000, consensusReached: true },
      operator: { userId: 'op-7', role: 'operator' },
      taskClass: 'conversational',
    } as unknown as AuditPayload['context'],
    mi9Result: {
      decisionId: 'dec-0001',
      verdict: 'allow',
      findings: [],
      policyVersion: 'test',
      evaluatedAt: '2026-08-30T04:00:00.000Z',
      humanCoSignRequired: false,
    } as unknown as AuditPayload['mi9Result'],
    aiProposal: { model: 'gpt-5.6', rationale: 'because', latencyMs: 42 },
    outcome: { action: 'executed' },
    metadata: { runtime_surface: 'query', cost_usd: 0.0031, mission_id: 'mis-9' },
    ...overrides,
  };
}

function veriga(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    seq: 20,
    recordId: 'rec-uuid-20',
    timestamp: '2026-08-30T04:00:00.000Z',
    payload: sarcina(),
    payloadHash: 'a'.repeat(64),
    prevHash: 'b'.repeat(64),
    chainHash: 'c'.repeat(64),
    ...overrides,
  };
}

/** A manager double that records what would have been written. */
function managerCareReuseste(): {
  randuri: Array<Record<string, unknown>>;
  recordAuditEvent: (row: unknown) => Promise<void>;
} {
  const randuri: Array<Record<string, unknown>> = [];
  return {
    randuri,
    async recordAuditEvent(row: unknown) {
      randuri.push(row as Record<string, unknown>);
    },
  };
}

const MEDIU_CONFIGURAT: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'http://ronor-gov-datalayer:8080',
  SUPABASE_SERVICE_ROLE_KEY: 'test-token-not-a-real-credential',
  SUPABASE_SCHEMA: 'ronor',
};

beforeEach(() => {
  reseteazaOglindire();
});

afterEach(() => {
  reseteazaOglindire();
});

// ---------------------------------------------------------------------------
// 1 · Traducerea vocabularului
// ---------------------------------------------------------------------------

describe('traducerea tipului de decizie în vocabularul constrâns', () => {
  const cazuri: Array<[string, string]> = [
    ['runtime.query.analysis', 'query'],
    ['runtime.query.dispatch', 'query'],
    ['governance.appeal.opened', 'cosign_requested'],
    ['governance.appeal.approved', 'cosign_approved'],
    ['governance.appeal.rejected', 'cosign_rejected'],
    ['governance.appeal.expired', 'cosign_expired'],
    ['governance.block', 'governance_block'],
    ['governance.blocked.irreversible', 'governance_block'],
    ['mission.dispatch', 'mission_dispatch'],
    ['mission.completed', 'mission_dispatch'],
    ['agent.spawned', 'agent_dispatch'],
    ['runtime.agents.dispatch', 'agent_dispatch'],
    ['knowledge.ingest.document', 'knowledge_ingest'],
    ['system.boot', 'system_boot'],
    ['system.shutdown', 'system_shutdown'],
  ];

  test.each(cazuri)('%s → %s', (tipLocal, asteptat) => {
    expect(traduTipEveniment(tipLocal)).toBe(asteptat);
  });

  test('a verdict of deny or block is recorded as a governance block', () => {
    expect(traduTipEveniment('energy.bess.dispatch', 'deny')).toBe('governance_block');
    expect(traduTipEveniment('energy.bess.dispatch', 'block')).toBe('governance_block');
  });

  test('anything else falls back to query and keeps the original type in the payload', () => {
    expect(traduTipEveniment('energy.bess.dispatch')).toBe('query');
    const rand = construiesteRandAudit(
      veriga({ payload: sarcina({ decisionType: 'energy.bess.dispatch' }) }),
    );
    expect(rand.event_type).toBe('query');
    expect(rand.payload_json.decision_type_original).toBe('energy.bess.dispatch');
  });

  test('a genuine query is NOT marked as a fallback translation', () => {
    const rand = construiesteRandAudit(veriga());
    expect(rand.event_type).toBe('query');
    expect(rand.payload_json.decision_type_original).toBeUndefined();
  });

  test('an absent or empty decision type still yields an admitted value', () => {
    expect(traduTipEveniment(undefined)).toBe('query');
    expect(traduTipEveniment('')).toBe('query');
  });

  test('every translation lands inside the constrained vocabulary', () => {
    const intrari = [
      ...cazuri.map(([tip]) => tip),
      '',
      'orice.altceva',
      'energy.bess.dispatch',
      'GOVERNANCE.APPEAL.OPENED',
    ];
    for (const tip of intrari) {
      for (const verdict of [undefined, 'allow', 'allow-with-cosign', 'escalate', 'deny', 'block']) {
        const tradus = traduTipEveniment(tip, verdict);
        expect(esteTipEvenimentPermis(tradus)).toBe(true);
        expect(TIPURI_EVENIMENT_PERMISE).toContain(tradus);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2 · Cheia de reconciliere și câmpurile completate
// ---------------------------------------------------------------------------

describe('câmpurile rândului relațional', () => {
  test('audit_chain_hash is the link chain_hash verbatim — the reconciliation key', () => {
    const chainHash = 'd'.repeat(64);
    const rand = construiesteRandAudit(veriga({ chainHash }));
    expect(rand.audit_chain_hash).toBe(chainHash);
    expect(rand.audit_chain_hash).toHaveLength(64);
  });

  test('the same hash reaches the manager unchanged when a link is mirrored', async () => {
    const manager = managerCareReuseste();
    configureazaOglindire({ manager, env: MEDIU_CONFIGURAT });
    const chainHash = 'e'.repeat(64);

    await oglindesteVeriga(veriga({ chainHash, seq: 19 }));

    expect(manager.randuri).toHaveLength(1);
    expect(manager.randuri[0].audit_chain_hash).toBe(chainHash);
    expect(stareOglindire().ultimul_seq_oglindit).toBe(19);
    expect(stareOglindire().oglindite).toBe(1);
  });

  test('request_id, verdict, occurred_at, model_id, latency_ms and cost_usd are carried', () => {
    const rand = construiesteRandAudit(veriga());
    expect(rand.request_id).toBe('dec-0001');
    expect(rand.verdict).toBe('allow');
    expect(rand.occurred_at).toBe('2026-08-30T04:00:00.000Z');
    expect(rand.model_id).toBe('gpt-5.6');
    expect(rand.latency_ms).toBe(42);
    expect(rand.cost_usd).toBeCloseTo(0.0031);
    expect(rand.mission_id).toBe('mis-9');
    expect(rand.user_id).toBe('op-7');
    expect(rand.channel).toBe('query');
  });

  test('absent optional payload fields become null rather than undefined', () => {
    const rand = construiesteRandAudit(
      veriga({
        payload: sarcina({
          aiProposal: { model: '', rationale: '' },
          metadata: {},
        }),
      }),
    );
    expect(rand.model_id).toBeNull();
    expect(rand.latency_ms).toBeNull();
    expect(rand.cost_usd).toBeNull();
    expect(rand.mission_id).toBeNull();
  });

  test('payload_json carries the link payload plus seq, record_id and prev_hash', () => {
    const rand = construiesteRandAudit(veriga({ seq: 7, recordId: 'rec-7', prevHash: 'f'.repeat(64) }));
    expect(rand.payload_json.seq).toBe(7);
    expect(rand.payload_json.record_id).toBe('rec-7');
    expect(rand.payload_json.prev_hash).toBe('f'.repeat(64));
    expect(rand.payload_json.decisionId).toBe('dec-0001');
  });
});

// ---------------------------------------------------------------------------
// 3 · Cosemnătura umană
// ---------------------------------------------------------------------------

describe('human_cosign_required', () => {
  test.each(['escalate', 'deny', 'block'])('is true for verdict %s', (verdict) => {
    expect(necesitaCosemnaturaUmana(verdict)).toBe(true);
    const rand = construiesteRandAudit(
      veriga({
        payload: sarcina({
          mi9Result: {
            ...sarcina().mi9Result,
            verdict,
            humanCoSignRequired: false,
          } as unknown as AuditPayload['mi9Result'],
        }),
      }),
    );
    expect(rand.human_cosign_required).toBe(true);
  });

  test('is false for a plain allow', () => {
    expect(necesitaCosemnaturaUmana('allow')).toBe(false);
    expect(construiesteRandAudit(veriga()).human_cosign_required).toBe(false);
  });

  test('respects the gate when the gate itself demands a co-signature', () => {
    expect(necesitaCosemnaturaUmana('allow-with-cosign', true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4 · Oglindirea nu poate strica lanțul local
// ---------------------------------------------------------------------------

describe('lanțul local rămâne autoritar', () => {
  test('a mirroring failure neither throws nor rejects', async () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          throw new Error('baza de guvernanță este inaccesibilă');
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    await expect(oglindesteVeriga(veriga())).resolves.toBe(false);
    const stare = stareOglindire();
    expect(stare.esuate).toBe(1);
    expect(stare.oglindite).toBe(0);
    expect(stare.ultima_eroare).toContain('inaccesibilă');
  });

  test('programeazaOglindire returns synchronously and swallows a failing mirror', () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          throw new Error('scriere respinsă');
        },
      },
      env: MEDIU_CONFIGURAT,
    });
    expect(() => programeazaOglindire(veriga())).not.toThrow();
  });

  test('PERSISTENCE_REQUIRED=true escalates to a degradation counter, not a refusal', async () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          throw new Error('indisponibil');
        },
      },
      env: { ...MEDIU_CONFIGURAT, PERSISTENCE_REQUIRED: 'true' },
    });

    await expect(oglindesteVeriga(veriga())).resolves.toBe(false);
    const stare = stareOglindire();
    expect(stare.persistenta_obligatorie).toBe(true);
    expect(stare.degradari).toBe(1);
    expect(stare.esuate).toBe(1);
  });

  test('append() writes the link and returns it even when mirroring fails', () => {
    // The real chain, on a scratch database, with a mirror that always throws.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-audit-mirror-'));
    const anterior = process.env.AUDIT_DB_PATH;
    process.env.AUDIT_DB_PATH = path.join(dir, 'audit.db');
    jest.resetModules();

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const oglinda = require('../../src/persistence/audit-mirror');
      oglinda.configureazaOglindire({
        manager: {
          async recordAuditEvent() {
            throw new Error('oglindire imposibilă');
          },
        },
        env: MEDIU_CONFIGURAT,
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const lant = require('../../src/audit/hash-chain');

      const inainte = lant.countRecords();
      const record = lant.append(sarcina({ decisionId: 'dec-lant' }));
      expect(record.chainHash).toMatch(/^[0-9a-f]{64}$/);
      expect(lant.countRecords()).toBe(inainte + 1);

      const alDoilea = lant.append(sarcina({ decisionId: 'dec-lant-2' }));
      expect(alDoilea.prevHash).toBe(record.chainHash);

      // The authoritative claim: the chain still verifies end to end.
      expect(lant.verifyChain().ok).toBe(true);
      lant.closeDb();
      oglinda.reseteazaOglindire();
    } finally {
      if (anterior === undefined) delete process.env.AUDIT_DB_PATH;
      else process.env.AUDIT_DB_PATH = anterior;
      fs.rmSync(dir, { recursive: true, force: true });
      jest.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// 5 · Sănătate onestă
// ---------------------------------------------------------------------------

describe('sănătatea persistenței relaționale', () => {
  test('an unconfigured register is degraded, with the reason stated', async () => {
    configureazaOglindire({ manager: null, env: {} });
    const raport = await raporteazaPersistenta(19);
    expect(raport.configurat).toBe(false);
    expect(raport.accesibil).toBe(false);
    expect(raport.degradat).toBe(true);
    expect(raport.motiv).toMatch(/neconfigurat/);
  });

  test('a configured but unreachable register is degraded, never healthy', async () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          throw new Error('ECONNREFUSED');
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    await oglindesteVeriga(veriga({ seq: 19 }));
    const raport = await raporteazaPersistenta(19);

    expect(raport.configurat).toBe(true);
    expect(raport.accesibil).toBe(false);
    expect(raport.degradat).toBe(true);
    expect(raport.ultima_eroare).toContain('ECONNREFUSED');
  });

  test('a reachable register is not degraded and reports zero unmirrored links', async () => {
    const manager = managerCareReuseste();
    configureazaOglindire({ manager, env: MEDIU_CONFIGURAT });

    await oglindesteVeriga(veriga({ seq: 19 }));
    const raport = await raporteazaPersistenta(19);

    expect(raport.accesibil).toBe(true);
    expect(raport.degradat).toBe(false);
    expect(raport.ultimul_seq_oglindit).toBe(19);
    expect(raport.verigi_neoglindite).toBe(0);
    expect(raport.ultima_reusita_la).not.toBeNull();
  });

  test('the unmirrored-link count is the gap against the local maximum sequence', async () => {
    const manager = managerCareReuseste();
    configureazaOglindire({ manager, env: MEDIU_CONFIGURAT });

    await oglindesteVeriga(veriga({ seq: 5 }));
    const raport = await raporteazaPersistenta(19);

    expect(raport.ultimul_seq_oglindit).toBe(5);
    expect(raport.verigi_neoglindite).toBe(14);
  });

  test('no configuration value is echoed into the health report', async () => {
    configureazaOglindire({ manager: null, env: MEDIU_CONFIGURAT });
    const raport = await raporteazaPersistenta(0);
    const serializat = JSON.stringify(raport);
    expect(serializat).not.toContain('test-token-not-a-real-credential');
  });
});
