/**
 * RONOR — Adaptorul relațional: starea observată, nu starea sperată
 * ─────────────────────────────────────────────────────────────────
 *
 * Testele de aici țintesc exact granițele pe care auditul independent dinaintea
 * fuziunii le-a găsit greșite. Amândouă sunt greșeli de graniță logică, nu
 * vulnerabilități: niciun analizor semantic nu le semnalează, fiindcă un `<` în
 * locul unui `≤` este cod perfect valid care spune altceva decât trebuie.
 *
 *   · R1 — `ping()` folosea `available = status < 500`. Un registru care răspunde
 *     `401 Unauthorized` la fiecare cerere era raportat drept ACCESIBIL, deci
 *     sănătatea arăta verde în timp ce fiecare rând de audit se pierdea. Șase din
 *     șase auditori independenți au semnalat această linie.
 *
 *   · R2 — `writeConfirmed` respingea doar `status >= 400`, deci orice 3xx era
 *     numărat drept inserare CONFIRMATĂ. O redirectare — de la un proxy pus în
 *     fața registrului sau de la o adresă mutată — avansa contoarele de oglindire
 *     pentru un rând care nu există nicăieri.
 *
 * Fiecare test pornește un server HTTP real și îi impune statusul. Un dublu de
 * test care returnează un număr nu ar dovedi nimic despre calea prin care
 * adaptorul citește chiar acel număr.
 */

import http from 'http';
import type { AddressInfo } from 'net';

import {
  SupabaseAdapter,
  loadSupabaseConfig,
  type AuditEventRow,
  type SupabaseConfig,
} from '../../src/persistence/supabase-adapter';

// ---------------------------------------------------------------------------
// Ajutoare
// ---------------------------------------------------------------------------

interface Registru {
  server: http.Server;
  url: string;
  /** Statusul cu care răspunde următoarea cerere. */
  status: number;
  cereri: Array<{ metoda: string; cale: string }>;
  inchide: () => Promise<void>;
}

async function registruFals(statusInitial: number): Promise<Registru> {
  const stare = { status: statusInitial };
  const cereri: Array<{ metoda: string; cale: string }> = [];

  const server = http.createServer((req, res) => {
    cereri.push({ metoda: req.method ?? '?', cale: req.url ?? '?' });
    // Un corp JSON valid la orice status: adaptorul respinge un corp neparsabil
    // cu o excepție, iar testul trebuie să izoleze DECIZIA pe status, nu parsarea.
    res.writeHead(stare.status, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    get status() {
      return stare.status;
    },
    set status(valoare: number) {
      stare.status = valoare;
    },
    cereri,
    inchide: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function configuratie(url: string, overrides: Partial<SupabaseConfig> = {}): SupabaseConfig {
  return {
    url,
    serviceRoleKey: 'test-token-not-a-real-credential',
    schema: 'ronor',
    required: false,
    ...overrides,
  };
}

function rand(): AuditEventRow {
  return {
    event_type: 'query',
    request_id: 'cerere-de-test',
    mission_id: null,
    user_id: null,
    channel: 'test',
    verdict: 'allow',
    human_cosign_required: false,
    cost_usd: null,
    latency_ms: null,
    model_id: null,
    audit_chain_hash: 'a'.repeat(64),
    occurred_at: '2026-08-30T04:00:00.000Z',
    payload_json: {},
  };
}

// ---------------------------------------------------------------------------
// 1 · R1 · Accesibil înseamnă 2xx, iar un refuz nu este o pană
// ---------------------------------------------------------------------------

describe('sonda de accesibilitate a registrului', () => {
  let registru: Registru;

  afterEach(async () => {
    if (registru) await registru.inchide();
  });

  test('un 2xx este singurul răspuns care înseamnă accesibil', async () => {
    registru = await registruFals(200);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    expect(await adaptor.ping()).toBe(true);
    expect(adaptor.isAvailable).toBe(true);
    expect(adaptor.stareRegistru).toBe('accesibil');
    expect(adaptor.motivulStarii).toBeNull();
  });

  test.each([401, 403])(
    'un %i este un REFUZ distinct, nu accesibilitate — regula retrasă `status < 500` spunea contrariul',
    async (status) => {
      registru = await registruFals(status);
      const adaptor = new SupabaseAdapter(configuratie(registru.url));

      expect(await adaptor.ping()).toBe(false);
      expect(adaptor.isAvailable).toBe(false);
      expect(adaptor.stareRegistru).toBe('refuzat_autorizare');
      expect(adaptor.motivulStarii).toContain('autorizarea');
      expect(adaptor.motivulStarii).toContain(String(status));
    },
  );

  test('un 404 este un refuz, nu o pană: tabelul lipsește, serverul răspunde', async () => {
    registru = await registruFals(404);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    expect(await adaptor.ping()).toBe(false);
    expect(adaptor.stareRegistru).toBe('refuzat');
  });

  // Exact 500 şi exact 300 sunt incluse deliberat: sunt marginile pe care o
  // testare prin mutaţii le-a găsit neacoperite. Un `>= 500` mutat în `> 500`, sau
  // un `< 300` mutat în `<= 300`, trece neobservat dacă suita sare peste valoarea
  // exactă a pragului.
  test.each([500, 503])('un %i este o pană: nimeni nu a răspuns util', async (status) => {
    registru = await registruFals(status);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    expect(await adaptor.ping()).toBe(false);
    expect(adaptor.stareRegistru).toBe('inaccesibil');
  });

  test('înainte de orice contact starea este necunoscută, nu accesibilă', async () => {
    registru = await registruFals(200);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    // Valoarea iniţială retrasă era `available = true`: primul raport de sănătate
    // putea pretinde un registru cu care nimeni nu vorbise încă.
    expect(adaptor.stareRegistru).toBe('necunoscut');
    expect(adaptor.isAvailable).toBe(false);
  });

  test('o eroare de transport lasă registrul inaccesibil', async () => {
    registru = await registruFals(200);
    const urlMort = registru.url;
    await registru.inchide();
    const adaptor = new SupabaseAdapter(configuratie(urlMort));

    expect(await adaptor.ping()).toBe(false);
    expect(adaptor.stareRegistru).toBe('inaccesibil');
    // Reînchiderea în afterEach este inofensivă.
    registru = { ...registru, inchide: async () => undefined };
  });
});

// ---------------------------------------------------------------------------
// 2 · R2 · O scriere e confirmată de un 2xx și de nimic altceva
// ---------------------------------------------------------------------------

describe('confirmarea scrierii în registru', () => {
  let registru: Registru;

  afterEach(async () => {
    if (registru) await registru.inchide();
  });

  test.each([200, 201, 204])('un %i confirmă scrierea', async (status) => {
    registru = await registruFals(status);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    expect(await adaptor.insertAuditEvent(rand())).toBe(true);
    expect(adaptor.stareRegistru).toBe('accesibil');
    expect(registru.cereri).toHaveLength(1);
    expect(registru.cereri[0]).toEqual({ metoda: 'POST', cale: '/rest/v1/audit_events' });
  });

  test.each([300, 301, 302, 307, 308])(
    'un %i NU confirmă scrierea — pragul retras `status >= 400` îl număra drept inserare reuşită',
    async (status) => {
      registru = await registruFals(status);
      const adaptor = new SupabaseAdapter(configuratie(registru.url));

      expect(await adaptor.insertAuditEvent(rand())).toBe(false);
      expect(adaptor.isAvailable).toBe(false);
      expect(adaptor.stareRegistru).toBe('refuzat');
    },
  );

  test.each([400, 401, 403, 409, 500])('un %i nu confirmă scrierea', async (status) => {
    registru = await registruFals(status);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    expect(await adaptor.insertAuditEvent(rand())).toBe(false);
    expect(adaptor.isAvailable).toBe(false);
  });

  test('cu PERSISTENCE_REQUIRED=true o eroare de transport este propagată, nu înghiţită', async () => {
    registru = await registruFals(200);
    const urlMort = registru.url;
    await registru.inchide();
    const adaptor = new SupabaseAdapter(configuratie(urlMort, { required: true }));

    await expect(adaptor.insertAuditEvent(rand())).rejects.toThrow();
    registru = { ...registru, inchide: async () => undefined };
  });

  test('cheia de serviciu nu apare niciodată în motivul stării', async () => {
    registru = await registruFals(401);
    const adaptor = new SupabaseAdapter(configuratie(registru.url));

    await adaptor.ping();
    expect(adaptor.motivulStarii ?? '').not.toContain('test-token-not-a-real-credential');
  });
});

// ---------------------------------------------------------------------------
// 3 · Configuraţia
// ---------------------------------------------------------------------------

describe('încărcarea configuraţiei', () => {
  test('absenţa adresei sau a cheii dezactivează persistenţa relaţională', () => {
    expect(loadSupabaseConfig({})).toBeNull();
    expect(loadSupabaseConfig({ SUPABASE_URL: 'http://x' })).toBeNull();
    expect(loadSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBeNull();
  });

  test('bara finală este tăiată, iar caracterul obligatoriu vine din mediu', () => {
    const config = loadSupabaseConfig({
      SUPABASE_URL: 'http://registru:8080///',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      PERSISTENCE_REQUIRED: 'true',
    });
    expect(config?.url).toBe('http://registru:8080');
    expect(config?.required).toBe(true);
    expect(config?.schema).toBe('ronor');
  });
});
