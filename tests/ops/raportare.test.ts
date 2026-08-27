/**
 * Reporting pipeline conformance tests — ops/raportare
 *
 * The reporting pipeline lives on the sovereign node as Python, but its
 * contract is enforced here so that CI is the gate. These tests assert the
 * invariants that made the previous reporter untrustworthy:
 *
 *  1. Every declared probe type is actually implemented by the collector.
 *  2. Every critical service carries the fields its probe type requires.
 *  3. Every deliberately stopped container carries a stated reason.
 *  4. The collector never emits a value without provenance.
 *  5. No secret is embedded in any pipeline file.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(__dirname, '..', '..', 'ops', 'raportare');
const INVENTAR = path.join(DIR, 'inventar.json');
const COLECTOR = path.join(DIR, 'colector.py');
const RANDARE = path.join(DIR, 'randare.py');
const TRIMITE = path.join(DIR, 'trimite.py');

/** Fields each probe type must supply, beyond `nume` and `sonda`. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  container: [],
  lucrator: [],
  http: ['url'],
  pagina: ['url', 'asteptat_text'],
  antet: ['url', 'cheie_din_mediu'],
  exec: ['comanda', 'asteptat_text'],
};

interface Serviciu {
  nume: string;
  sonda?: string;
  url?: string;
  comanda?: string;
  asteptat_text?: string;
  asteptat_cheie?: string;
  cheie_din_mediu?: string;
  nota?: string;
}

interface Inventar {
  schema: string;
  servicii_critice: Serviciu[];
  servicii_declarative: string[];
  oprite_deliberat: {
    nume?: string[];
    sufixe?: string[];
    prefixe_nume?: string[];
    sarcini_efemere?: string[];
    motive: Record<string, string>;
  };
  praguri: Record<string, unknown>;
  batai_de_inima: Record<string, unknown>;
}

const inventar: Inventar = JSON.parse(fs.readFileSync(INVENTAR, 'utf8'));
const colector = fs.readFileSync(COLECTOR, 'utf8');
const randare = fs.readFileSync(RANDARE, 'utf8');
const trimite = fs.readFileSync(TRIMITE, 'utf8');

describe('inventar.json — declared inventory', () => {
  it('declares a schema identifier', () => {
    expect(typeof inventar.schema).toBe('string');
    expect(inventar.schema.length).toBeGreaterThan(0);
  });

  it('declares at least one critical service', () => {
    expect(Array.isArray(inventar.servicii_critice)).toBe(true);
    expect(inventar.servicii_critice.length).toBeGreaterThan(0);
  });

  it('has no duplicate service names', () => {
    const nume = inventar.servicii_critice.map((s) => s.nume);
    expect(new Set(nume).size).toBe(nume.length);
  });

  it('uses only probe types the collector implements', () => {
    // The collector declares its implemented probe types in one tuple.
    const m = colector.match(/^SONDE = \(([^)]*)\)/m);
    expect(m).not.toBeNull();
    const implementate = (m as RegExpMatchArray)[1]
      .split(',')
      .map((x) => x.trim().replace(/^"|"$/g, ''))
      .filter((x) => x.length > 0);

    // The tuple and this test's field table must describe the same set,
    // so a new probe type cannot be added without stating its contract.
    expect(implementate.sort()).toEqual(Object.keys(REQUIRED_FIELDS).sort());

    for (const s of inventar.servicii_critice) {
      expect(implementate).toContain(s.sonda ?? 'container');
    }
  });

  it('refuses an unknown probe type instead of falling through to HTTP', () => {
    expect(colector).toContain('tip not in SONDE');
    expect(colector).toContain('tip de sonda necunoscut');
  });

  it('supplies every field its probe type requires', () => {
    for (const s of inventar.servicii_critice) {
      const tip = s.sonda ?? 'container';
      for (const camp of REQUIRED_FIELDS[tip]) {
        const val = (s as unknown as Record<string, unknown>)[camp];
        expect(typeof val).toBe('string');
        expect((val as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('probes loopback or private addresses only', () => {
    for (const s of inventar.servicii_critice) {
      if (!s.url) continue;
      expect(s.url).toMatch(/^http:\/\/(127\.0\.0\.1|172\.|10\.|192\.168\.)/);
    }
  });

  it('states a reason for every deliberately stopped entry', () => {
    const od = inventar.oprite_deliberat;
    const chei = [
      ...(od.nume ?? []),
      ...(od.sufixe ?? []),
      ...(od.prefixe_nume ?? []),
      ...(od.sarcini_efemere ?? []),
    ];
    expect(chei.length).toBeGreaterThan(0);
    for (const k of chei) {
      expect(typeof od.motive[k]).toBe('string');
      expect(od.motive[k].length).toBeGreaterThan(10);
    }
  });

  it('declares the sovereign service list used for the compliance count', () => {
    expect(Array.isArray(inventar.servicii_declarative)).toBe(true);
    expect(inventar.servicii_declarative.length).toBeGreaterThan(0);
    expect(new Set(inventar.servicii_declarative).size).toBe(
      inventar.servicii_declarative.length,
    );
  });
});

describe('colector.py — provenance contract', () => {
  it('defines the three confidence grades', () => {
    for (const grad of ['verificat', 'derivat', 'neverificat']) {
      expect(colector).toContain(`"${grad}"`);
    }
  });

  it('stamps every measurement with source, time and confidence', () => {
    // The single constructor for a reported value must carry all three.
    expect(colector).toMatch(/"sursa"/);
    expect(colector).toMatch(/"la"/);
    expect(colector).toMatch(/"incredere"/);
  });

  it('guards HTTP probes against SPA catch-all responses', () => {
    // A 200 from a catch-all proves nothing; the probe must check a JSON key.
    expect(colector).toContain('asteptat_cheie');
    expect(colector).toContain('json.loads');
  });

  it('classifies stopped containers against the inventory, not a hardcoded list', () => {
    expect(colector).toContain('e_deliberat');
    expect(colector).toMatch(/prefixe_nume/);
    expect(colector).toMatch(/sufixe/);
  });

  it('separates unknown health from healthy', () => {
    expect(colector).toContain('fara_verificare_sanatate');
    expect(colector).toContain('fara_sonda_neacoperite');
  });

  it('exempts declared run-to-completion tasks from the restart check', () => {
    expect(colector).toContain('sarcini_efemere');
  });

  it('supports a dry run that writes and sends nothing', () => {
    expect(colector).toContain('--sec');
    expect(trimite).toContain('--sec');
  });

  it('writes a heartbeat so silence is distinguishable from calm', () => {
    expect(colector + randare).toMatch(/batai/);
  });
});

describe('pipeline files — no embedded secrets', () => {
  const fisiere: Array<[string, string]> = [
    ['colector.py', colector],
    ['randare.py', randare],
    ['trimite.py', trimite],
    ['inventar.json', fs.readFileSync(INVENTAR, 'utf8')],
  ];

  it('reads credentials from the environment, never from a literal', () => {
    for (const [nume, text] of fisiere) {
      // Long hex or base64-ish runs are the shape of a leaked key.
      expect(text).not.toMatch(/[A-Fa-f0-9]{40,}/);
      // Telegram bot tokens and Resend keys have recognisable prefixes.
      expect(text).not.toMatch(/\bre_[A-Za-z0-9]{16,}/);
      expect(text).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{30,}/);
      expect(nume).toBeTruthy();
    }
  });

  it('takes the Qdrant key from the environment by name only', () => {
    expect(colector).toContain('cheie_din_mediu');
    expect(JSON.stringify(inventar)).toContain('QDRANT_API_KEY');
  });

  it('reuses the existing delivery functions instead of reimplementing them', () => {
    expect(trimite).toContain('from ronor_report import send_telegram, send_email');
  });
});
