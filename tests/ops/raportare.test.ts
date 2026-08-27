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
 *  6. The exposure section is measured read-only, never emits a password
 *     hash, and an unexplained successful login degrades the verdict.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(__dirname, '..', '..', 'ops', 'raportare');
const INVENTAR = path.join(DIR, 'inventar.json');
const COLECTOR = path.join(DIR, 'colector.py');
const RANDARE = path.join(DIR, 'randare.py');
const TRIMITE = path.join(DIR, 'trimite.py');

/**
 * Exposure measurements the collector must produce, mirroring its EXPUNERE
 * tuple. A measurement declared in one place and missing in the other is the
 * failure mode this table exists to prevent.
 */
const EXPUNERE_ASTEPTATE = [
  'porturi_publice',
  'porturi_neasteptate',
  'autentificare_parola',
  'conturi_atacabile',
  'protectie_ghicire',
  'tentative',
  'tailscale_ssh',
  'intrari_reusite_necunoscute',
];

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

interface Recunoastere {
  cont?: string;
  sursa?: string;
  pana_la?: string;
  recunoscut_la?: string;
  motiv?: string;
}

interface Expunere {
  retele_cunoscute: string[];
  porturi_publice_asteptate: number[];
  procese_publice_asteptate: string[];
  jurnal_autentificare: string;
  stare_fisier: string;
  intrari_recunoscute?: Recunoastere[];
}

interface Inventar {
  schema: string;
  expunere: Expunere;
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

describe('inventar.json — declared exposure surface', () => {
  it('declares the exposure block', () => {
    expect(typeof inventar.expunere).toBe('object');
  });

  it('declares at least one known network, each a valid CIDR', () => {
    const r = inventar.expunere.retele_cunoscute;
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    for (const net of r) {
      expect(net).toMatch(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
    }
  });

  it('declares the Tailscale range, so tailnet logins are not false alarms', () => {
    expect(inventar.expunere.retele_cunoscute).toContain('100.64.0.0/10');
  });

  it('declares the public ports that are expected to be open', () => {
    const p = inventar.expunere.porturi_publice_asteptate;
    expect(Array.isArray(p)).toBe(true);
    expect(p.length).toBeGreaterThan(0);
    for (const port of p) {
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    }
  });

  it('exempts ephemeral-port processes by name, not by port number', () => {
    // Tailscale picks a fresh port each start. Exempting the number would
    // raise an alarm on every restart, and an alarm that means nothing
    // teaches the reader to ignore all of them.
    const p = inventar.expunere.procese_publice_asteptate;
    expect(Array.isArray(p)).toBe(true);
    expect(p).toContain('tailscaled');
  });

  it('declares the auth log and the state file used for the delta', () => {
    expect(inventar.expunere.jurnal_autentificare).toMatch(/^\//);
    expect(inventar.expunere.stare_fisier).toMatch(/^\/.*\.json$/);
  });
});

describe('colector.py — exposure contract', () => {
  it('implements exactly the exposure measurements this table declares', () => {
    const m = colector.match(/^EXPUNERE = \(([\s\S]*?)\)/m);
    expect(m).not.toBeNull();
    const implementate = (m as RegExpMatchArray)[1]
      .split(',')
      .map((x) => x.trim().replace(/^"|"$/g, ''))
      .filter((x) => x.length > 0);
    expect(implementate.sort()).toEqual([...EXPUNERE_ASTEPTATE].sort());
  });

  it('reads the exposure block from the inventory, not from hardcoded values', () => {
    expect(colector).toContain("inv.get(\"expunere\")");
    expect(colector).toContain('retele_cunoscute');
    expect(colector).toContain('porturi_publice_asteptate');
    expect(colector).toContain('procese_publice_asteptate');
  });

  it('measures exposure strictly read-only', () => {
    // The collector must never repair what it observes: no firewall change,
    // no account change, no service start, no package install.
    const interzise = [
      'ufw allow',
      'ufw deny',
      'ufw limit',
      'ufw delete',
      'passwd -l',
      'usermod',
      'systemctl start',
      'systemctl enable',
      'systemctl restart',
      'apt-get',
      'apt install',
      'sshd -t -f',
      'PasswordAuthentication no',
    ];
    for (const cmd of interzise) {
      expect(colector).not.toContain(cmd);
    }
  });

  it('never emits a password hash, only the account name', () => {
    // The shadow read must project field 1 (the name), never field 2, and
    // must not report the hash's length or shape either — that is still
    // information about the secret. Scoped to the /etc/shadow command, since
    // free and df legitimately read their own second column.
    const linii = colector
      .split('\n')
      .filter((l) => l.includes('/etc/shadow') && l.includes('awk'));
    expect(linii.length).toBeGreaterThan(0);
    for (const l of linii) {
      expect(l).toContain('{print $1}');
      expect(l).not.toMatch(/print[^}]*\$2/);
      expect(l).not.toContain('substr($2');
    }
    expect(colector).not.toContain('length($2)}');
  });

  it('excuses root from the guessable set when root is key-only', () => {
    expect(colector).toContain('prohibit-password');
    expect(colector).toContain('without-password');
  });

  it('decides known sources by network membership, not string prefix', () => {
    expect(colector).toContain('ipaddress.ip_network');
    expect(colector).toContain('ipaddress.ip_address');
  });

  it('covers Tailscale SSH logins, which never reach the sshd log', () => {
    // wtmp records them; the sshd "Accepted" line does not.
    expect(colector).toContain('last -F');
    expect(colector).toContain('RunSSH');
  });

  it('treats an unmeasurable source as undecidable, not as known', () => {
    expect(colector).toContain('sursa_nedecidabila');
  });

  it('does not mistake a local console login for an unknown source', () => {
    // A tty1 line in `last` carries no host, so its third column is the
    // weekday. Without this, every report would raise the same false alarm.
    expect(colector).toContain('_ZILE_LAST');
    for (const zi of ['Mon', 'Thu', 'Sun']) {
      expect(colector).toContain('"' + zi + '"');
    }
    expect(colector).toMatch(/terminal\.startswith\("tty"\)/);
  });

  it('does not report a delta across a rotated log', () => {
    expect(colector).toContain('jurnal rotit');
  });

  it('writes no exposure state during a dry run', () => {
    expect(colector).toMatch(/if not sec:\s*\n\s*_scrie_stare/);
  });
});

describe('verdict — exposure weighting', () => {
  it('degrades on a successful login from an unknown source', () => {
    const i = colector.indexOf('EXP-INTRARE-NECUNOSCUTA');
    expect(i).toBeGreaterThan(-1);
    // The weight must be attached to this code, not to a neighbouring one.
    const fereastra = colector.slice(i, i + 400);
    expect(fereastra).toContain('"degradat"');
  });

  it('treats standing exposure risks as attention, not as degradation', () => {
    for (const cod of [
      'EXP-PAROLA-DESCHISA',
      'EXP-FARA-PROTECTIE',
      'EXP-PORT-NEDECLARAT',
      'EXP-TAILSCALE-SSH',
    ]) {
      const i = colector.indexOf(cod);
      expect(i).toBeGreaterThan(-1);
      expect(colector.slice(i, i + 400)).toContain('"atentie"');
    }
  });

  it('flags an unmeasurable exposure instead of passing it silently', () => {
    expect(colector).toContain('EXP-NEVERIFICAT');
    expect(colector).toContain('EXP-NEDECLARAT');
  });

  it('states the widened degradation rule in the rendered report', () => {
    expect(randare).toContain('sursă necunoscută');
  });
});

describe('registrul de intrări recunoscute — an acknowledgement is not a mute', () => {
  // A recognised entry stops degrading the verdict. That is a deliberate
  // weakening of the loudest signal the pipeline has, so every constraint
  // that keeps it honest is enforced here rather than left to review.

  const registru = inventar.expunere.intrari_recunoscute ?? [];

  it('requires an account, a source, a reason and an expiry on every entry', () => {
    for (const e of registru) {
      expect(typeof e.cont).toBe('string');
      expect((e.cont as string).length).toBeGreaterThan(0);
      expect(typeof e.sursa).toBe('string');
      expect((e.sursa as string).length).toBeGreaterThan(0);
      // A reason long enough to be a reason. "resolved" explains nothing to
      // whoever reads this registry six months from now.
      expect((e.motiv ?? '').length).toBeGreaterThan(40);
      expect(e.pana_la).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never acknowledges a whole account, a whole network, or everything', () => {
    // A wildcard would turn the registry from a record of decisions into a
    // permanent exemption, which is the failure mode it exists to prevent.
    for (const e of registru) {
      for (const camp of [e.cont, e.sursa]) {
        expect(camp).not.toContain('*');
        expect(camp).not.toContain('/');
        expect(camp).not.toMatch(/^(any|all|orice|to[a-z]*)$/i);
      }
    }
  });

  it('gives every acknowledgement an end, and none longer than a quarter', () => {
    for (const e of registru) {
      const termen = new Date(`${e.pana_la}T00:00:00Z`).getTime();
      expect(Number.isNaN(termen)).toBe(false);
      const inceput = e.recunoscut_la
        ? new Date(`${e.recunoscut_la}T00:00:00Z`).getTime()
        : termen;
      const zile = (termen - inceput) / 86_400_000;
      expect(zile).toBeLessThanOrEqual(100);
    }
  });

  it('validates the registry in the collector rather than trusting the file', () => {
    expect(colector).toContain('def _recunoscute');
    const i = colector.indexOf('def _recunoscute');
    const corp = colector.slice(i, i + 2600);
    // Each of the four rejection paths must exist: a missing field, a missing
    // reason, a missing expiry, and an expiry already past.
    expect(corp).toContain('fara motiv');
    expect(corp).toContain('fara termen');
    expect(corp).toContain('expirata');
    expect(corp).toMatch(/termen\s*<\s*azi/);
  });

  it('lets an expired acknowledgement degrade the verdict again', () => {
    // The expiry is what makes the registry self-cleaning: nothing stays
    // acknowledged because everyone forgot it was.
    const i = colector.indexOf('def _recunoscute');
    expect(colector.slice(i, i + 2600)).not.toMatch(/valide\[[^\]]*\]\s*=[\s\S]{0,80}expirata/);
    expect(colector).toContain('EXP-RECUNOASTERE-NEVALIDA');
    const j = colector.indexOf('EXP-RECUNOASTERE-NEVALIDA');
    expect(colector.slice(j, j + 400)).toContain('"atentie"');
  });

  it('still shows the acknowledged entry, with its reason and its expiry', () => {
    // Acknowledged must not mean invisible. If the report stopped printing
    // it, the registry would be a way of deleting evidence.
    expect(randare).toContain('recunoscută până la');
    const i = randare.indexOf('recunoscută până la');
    expect(randare.slice(i, i + 300)).toContain('motiv');
  });

  it('reports an acknowledgement that matches nothing, so the registry is pruned', () => {
    expect(colector).toContain('recunoasteri_nefolosite');
    expect(randare).toContain('fără intrare corespunzătoare');
  });

  it('keeps the registry in the repository, not in mutable state on the host', () => {
    // An acknowledgement is a decision and must arrive through review. If the
    // collector could write one, the host could silence itself.
    const i = colector.indexOf('def _recunoscute');
    const corp = colector.slice(i, i + 2600);
    expect(corp).not.toMatch(/open\([^)]*["']w["']/);
    expect(corp).not.toContain('json.dump');
    const j = colector.indexOf('def _scrie_stare');
    expect(colector.slice(j, j + 700)).not.toContain('recunosc');
  });
});

describe('randare.py — exposure placement', () => {
  it('renders the full section only where the report is read at length', () => {
    expect(randare).toMatch(/EXPUNERE_COMPLETA = \([^)]*"CBD"/);
    expect(randare).toMatch(/EXPUNERE_LINIE = \([^)]*"OBD"/);
  });

  it('keeps the weekly report free of a third copy of the same figures', () => {
    const complet = randare.match(/EXPUNERE_COMPLETA = \(([^)]*)\)/);
    const linie = randare.match(/EXPUNERE_LINIE = \(([^)]*)\)/);
    expect(complet).not.toBeNull();
    expect(linie).not.toBeNull();
    const toate =
      (complet as RegExpMatchArray)[1] + (linie as RegExpMatchArray)[1];
    expect(toate).not.toContain('TODO');
  });

  it('condenses the morning report to a single line', () => {
    expect(randare).toContain('def linie_expunere');
    expect(randare).toContain('def sectiune_expunere');
  });

  it('distinguishes zero unknown logins from an unmeasured count', () => {
    // Returning None rather than 0 is what keeps a failed measurement from
    // reading as an all-clear.
    expect(randare).toContain('def numar_necunoscute');
    expect(randare).toMatch(/nemăsurat/i);
  });

  it('states in the report that the measurement changes nothing', () => {
    expect(randare).toContain('strict prin citire');
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
