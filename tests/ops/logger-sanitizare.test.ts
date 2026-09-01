/**
 * Sanitizarea jurnalului — dovada ca injectia de linii noi nu mai e posibila,
 * si ca remedierea nu a distrus urma de stiva a erorilor.
 *
 * Alertele CodeQL js/log-injection #91 si #92 (src/utils/logger.ts) cereau ca
 * argumentele influentate de utilizator sa nu poata introduce linii noi in
 * jurnal. Remedierea converteste fiecare argument la un text de o singura linie.
 * Testul de mai jos apara ambele proprietati: linia unica SI informatia utila.
 */

import { createLogger } from '../../src/utils/logger';

describe('sanitizarea argumentelor de jurnal', () => {
  const original = { log: console.log, error: console.error };
  let capturat: unknown[][] = [];

  beforeEach(() => {
    capturat = [];
    process.env.LOG_LEVEL = 'debug';
    console.log = (...args: unknown[]) => {
      capturat.push(args);
    };
    console.error = (...args: unknown[]) => {
      capturat.push(args);
    };
  });

  afterEach(() => {
    console.log = original.log;
    console.error = original.error;
  });

  it('elimina linia noua injectata dintr-un text controlat de apelant', () => {
    const logger = createLogger('Test');
    logger.info('utilizator=admin\n[2026-01-01T00:00:00Z] [INFO] [Test] linie falsificata');

    expect(capturat).toHaveLength(1);
    const argumente = capturat[0].slice(1) as string[];
    for (const valoare of argumente) {
      expect(typeof valoare).toBe('string');
      expect(valoare).not.toMatch(/[\r\n]/);
    }
    expect(argumente.join(' ')).toContain('linie falsificata');
  });

  it('elimina si retururile de caret, nu doar liniile noi', () => {
    const logger = createLogger('Test');
    logger.warn('a\r\nb\rc\nd');

    const text = (capturat[0].slice(1) as string[]).join(' ');
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('d');
  });

  it('pastreaza urma de stiva a unei erori, pe o singura linie', () => {
    const logger = createLogger('Test');
    const eroare = new Error('ceva a cazut');
    logger.error('operatie esuata:', eroare);

    const argumente = capturat[0].slice(1) as string[];
    const text = argumente.join(' ');
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('Error: ceva a cazut');
    // Cadrul de stiva trebuie sa supravietuiasca sanitizarii.
    expect(text).toMatch(/logger-sanitizare\.test\.ts/);
  });

  it('sanitizeaza si mesajul unei erori care contine linii noi', () => {
    const logger = createLogger('Test');
    logger.error(new Error('prima linie\na doua linie injectata'));

    const text = (capturat[0].slice(1) as string[]).join(' ');
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('a doua linie injectata');
  });

  it('nu cade pe valori care nu se pot serializa', () => {
    const logger = createLogger('Test');
    const ciclic: Record<string, unknown> = {};
    ciclic.eu = ciclic;

    expect(() => logger.info(ciclic, undefined, BigInt(7))).not.toThrow();
    const argumente = capturat[0].slice(1) as string[];
    for (const valoare of argumente) {
      expect(typeof valoare).toBe('string');
      expect(valoare).not.toMatch(/[\r\n]/);
    }
    // Obiectul ciclic devine o descriere de forma, nu o serializare integrala.
    expect(argumente.join(' ')).toContain('chei=[eu]');
  });
});
