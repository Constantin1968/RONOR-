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
  interogheazaAccesibilitate,
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

  // R3 · Defectul confirmat de 6 din 6 auditori independenți. Formula retrasă era
  // `Math.max(0, seqLocal − ultimul_seq_oglindit)`: o DISTANȚĂ între două maxime,
  // nu un număr de găuri. Testul de mai jos e exact cazul în care distanța minte.
  test('a hole between two mirrored links is counted, not erased by the high-water mark', async () => {
    let respinge = false;
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          return !respinge;
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    for (let seq = 1; seq <= 9; seq += 1) {
      await oglindesteVeriga(veriga({ seq }));
    }
    respinge = true;
    await oglindesteVeriga(veriga({ seq: 10 })); // veriga pierdută
    respinge = false;
    await oglindesteVeriga(veriga({ seq: 11 }));

    const raport = await raporteazaPersistenta(11);

    // Reperul a ajuns la 11, deci formula retrasă dă `11 − 11 = 0`: o gaură în
    // pista de audit raportată drept pistă completă. Numărarea apartenenței nu
    // poate produce acel răspuns.
    expect(raport.ultimul_seq_oglindit).toBe(11);
    expect(raport.verigi_neoglindite).toBe(1);
    expect(raport.seq_prima_neoglindita).toBe(10);
    // Și sănătatea judecă scrierile confirmate, nu doar accesibilitatea: registrul
    // răspunde, dar cele două registre nu se mai reconciliază.
    expect(raport.degradat).toBe(true);
    expect(raport.motiv).toMatch(/neconfirmat/);
    expect(raport.motiv).toContain('seq=10');
  });

  test('two holes far apart are both counted', async () => {
    const pierdute = new Set([4, 12]);
    let curent = 0;
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          return !pierdute.has(curent);
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    for (let seq = 1; seq <= 15; seq += 1) {
      curent = seq;
      await oglindesteVeriga(veriga({ seq }));
    }

    const raport = await raporteazaPersistenta(15);
    expect(raport.verigi_neoglindite).toBe(2);
    expect(raport.seq_prima_neoglindita).toBe(4);
    expect(raport.degradat).toBe(true);
  });

  test('a fully mirrored chain reports zero holes and is not degraded', async () => {
    configureazaOglindire({ manager: managerCareReuseste(), env: MEDIU_CONFIGURAT });
    for (let seq = 1; seq <= 12; seq += 1) {
      await oglindesteVeriga(veriga({ seq }));
    }
    const raport = await raporteazaPersistenta(12);
    expect(raport.verigi_neoglindite).toBe(0);
    // Prefixul confirmat contiguu e compactat: prima verigă neconfirmată este cea
    // care urmează, nu una existentă. Astfel memoria rămâne plată pe calea
    // sănătoasă, în loc să crească cu o intrare pe decizie auditată.
    expect(raport.seq_prima_neoglindita).toBe(13);
    expect(raport.degradat).toBe(false);
  });

  test('no configuration value is echoed into the health report', async () => {
    configureazaOglindire({ manager: null, env: MEDIU_CONFIGURAT });
    const raport = await raporteazaPersistenta(0);
    const serializat = JSON.stringify(raport);
    expect(serializat).not.toContain('test-token-not-a-real-credential');
  });
});

// ---------------------------------------------------------------------------
// 6 · Confirmarea scrierii — o respingere nu e o reușită
// ---------------------------------------------------------------------------
//
// Auditul dinaintea fuziunii a găsit aici defectul de fond: reușita era dedusă
// din steagul de accesibilitate al adaptorului, iar acel steag rămâne adevărat
// la o respingere 4xx, fiindcă registrul a răspuns — doar că a refuzat. Un rând
// respins avansa contoarele ca oglindit. Registrul rămânea cu găuri și arăta
// complet, adică exact verdele fals pe care lucrarea aceasta există să îl
// elimine.

describe('confirmarea scrierii relaționale', () => {
  test('a rejected write is counted as a failure, not as a mirrored link', async () => {
    let apeluri = 0;
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          apeluri += 1;
          // Registrul a răspuns și a refuzat: rândul e pierdut.
          return false;
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    const rezultat = await oglindesteVeriga(veriga({ seq: 7 }));

    expect(apeluri).toBe(1);
    expect(rezultat).toBe(false);
    const raport = await raporteazaPersistenta(7);
    expect(raport.oglindite).toBe(0);
    expect(raport.esuate).toBe(1);
    expect(raport.ultimul_seq_oglindit).toBeNull();
    // O singură verigă a fost observată și o singură verigă lipsește. Verigile 1–6
    // nu au trecut prin acest proces, deci nu pot fi declarate neoglindite:
    // formula retrasă le număra (7 − 0 = 7) și pretindea astfel o cunoaștere pe
    // care procesul nu o are. Fereastra de numărare este declarată explicit.
    expect(raport.verigi_neoglindite).toBe(1);
    expect(raport.seq_prima_neoglindita).toBe(7);
    expect(raport.degradat).toBe(true);
    expect(raport.ultima_eroare).toContain('respins');
  });

  test('a confirmed write advances the mirrored counters', async () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          return true;
        },
      },
      env: MEDIU_CONFIGURAT,
    });

    const rezultat = await oglindesteVeriga(veriga({ seq: 11 }));

    expect(rezultat).toBe(true);
    const raport = await raporteazaPersistenta(11);
    expect(raport.oglindite).toBe(1);
    expect(raport.esuate).toBe(0);
    expect(raport.ultimul_seq_oglindit).toBe(11);
    expect(raport.verigi_neoglindite).toBe(0);
  });

  test('a rejection with PERSISTENCE_REQUIRED=true is a degradation, never a refusal', async () => {
    configureazaOglindire({
      manager: {
        async recordAuditEvent() {
          return false;
        },
      },
      env: { ...MEDIU_CONFIGURAT, PERSISTENCE_REQUIRED: 'true' },
    });

    // Nu aruncă și nu blochează: veriga locală era deja scrisă când oglindirea
    // rulează, iar stratul de audit nu are voie să suprime consemnarea unei
    // decizii care s-a întâmplat deja.
    await expect(oglindesteVeriga(veriga({ seq: 3 }))).resolves.toBe(false);

    const raport = await raporteazaPersistenta(3);
    expect(raport.degradari).toBe(1);
    expect(raport.esuate).toBe(1);
    expect(raport.oglindite).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7 · Interogarea de accesibilitate — lentoarea nu e dovadă de absență
// ---------------------------------------------------------------------------
//
// Al doilea audit a găsit aici cuplajul periculos: termenul propriu de 2 s
// returna `false`, adică „inaccesibil". Cât timp persistența e opțională e
// inofensiv, dar la poarta următoare — PERSISTENCE_REQUIRED=true — un singur
// răspuns lent ar fi retras pregătirea și ar fi oprit serviciile care așteaptă
// acest runtime: o indisponibilitate fabricată de propria verificare de
// sănătate.

describe('interogarea de accesibilitate', () => {
  test('a prompt confirmation is reported as reachable', async () => {
    await expect(interogheazaAccesibilitate({ ping: async () => true })).resolves.toBe('accesibil');
  });

  test('a refusal is reported as unreachable', async () => {
    await expect(interogheazaAccesibilitate({ ping: async () => false })).resolves.toBe(
      'inaccesibil',
    );
    await expect(
      interogheazaAccesibilitate({
        ping: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).resolves.toBe('inaccesibil');
  });

  test('running out of time is inconclusive, never a verdict of absence', async () => {
    const stare = await interogheazaAccesibilitate({
      ping: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_600)),
    });
    expect(stare).toBe('nedeterminat');
  });

  test('the late answer of a slow probe is still learned', async () => {
    let apeluri = 0;
    const adaptorLent = {
      ping: () => {
        apeluri += 1;
        return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_400));
      },
    };

    expect(await interogheazaAccesibilitate(adaptorLent)).toBe('nedeterminat');
    // Sonda a continuat după ce a pierdut cursa; răspunsul ei întârziat se
    // consemnează, deci apelul următor nu mai deschide un socket nou.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await interogheazaAccesibilitate(adaptorLent)).toBe('accesibil');
    expect(apeluri).toBe(1);
  });

  test('only a confirmation is memoised — a failure is never cached', async () => {
    let apeluri = 0;
    const adaptorPicat = {
      ping: async () => {
        apeluri += 1;
        return false;
      },
    };

    expect(await interogheazaAccesibilitate(adaptorPicat)).toBe('inaccesibil');
    expect(await interogheazaAccesibilitate(adaptorPicat)).toBe('inaccesibil');
    // Fără memorare la eșec, revenirea se vede la primul apel următor, nu după
    // expirarea unei memorii.
    expect(apeluri).toBe(2);

    let apeluriReusite = 0;
    const adaptorReusit = {
      ping: async () => {
        apeluriReusite += 1;
        return true;
      },
    };
    expect(await interogheazaAccesibilitate(adaptorReusit)).toBe('accesibil');
    expect(await interogheazaAccesibilitate(adaptorReusit)).toBe('accesibil');
    expect(apeluriReusite).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8 · Calea de producție cere confirmare explicită
// ---------------------------------------------------------------------------

describe('managerul care nu raportează nimic', () => {
  test('on the production path, silence is a failure and not a mirrored link', async () => {
    // Fără manager injectat: mediul e configurat, deci oglindirea rezolvă
    // managerul real. Cheia de test nu duce nicăieri, deci scrierea nu poate fi
    // confirmată — și neconfirmat înseamnă eșec, nu reușită presupusă.
    configureazaOglindire({ manager: null, env: MEDIU_CONFIGURAT });

    const rezultat = await oglindesteVeriga(veriga({ seq: 4 }));

    expect(rezultat).toBe(false);
    const raport = await raporteazaPersistenta(4);
    expect(raport.oglindite).toBe(0);
    expect(raport.esuate).toBeGreaterThan(0);
    expect(raport.ultimul_seq_oglindit).toBeNull();
    expect(raport.degradat).toBe(true);
  });
});
