/**
 * RONOR — Calea de sănătate nu poate doborî procesul
 * ─────────────────────────────────────────────────
 *
 * R4 din auditul independent. `/health` compune răspunsul din orchestrator, din
 * planul sentinelă și — de la lucrarea de oglindire — dintr-o citire SINCRONĂ a
 * lanțului local de audit. O excepție oriunde în compunere, într-un gestionar
 * Express `async`, produce o respingere netratată și NICIUN răspuns: sonda
 * containerului așteaptă, expiră, iar orchestratorul repornește un runtime care
 * răspundea corect pe toate celelalte rute. Pana ar fi fabricată integral de
 * verificarea de sănătate.
 *
 * Regula adoptată: incapacitatea de a DESCRIE runtime-ul se raportează drept
 * degradare cu motivul stat, niciodată drept excepție și niciodată drept liniște.
 */

import { compuneSauDegradat, masoaraSauNecunoscut } from '../../src/health/protejare';

describe('compunerea protejată a sănătății', () => {
  test('o compunere reușită trece neatinsă', async () => {
    const corp = await compuneSauDegradat(
      async () => ({ status: 'ok' }),
      () => ({ status: 'degraded' }),
    );
    expect(corp).toEqual({ status: 'ok' });
  });

  test('o excepție devine degradare cu motivul stat, nu o respingere', async () => {
    const corp = await compuneSauDegradat<{ status: string; motiv?: string }>(
      async () => {
        throw new Error('orchestratorul nu a răspuns');
      },
      (motiv) => ({ status: 'degraded', motiv }),
    );
    expect(corp.status).toBe('degraded');
    expect(corp.motiv).toBe('orchestratorul nu a răspuns');
  });

  test('o excepție sincronă, aruncată înainte de primul await, este prinsă la fel', async () => {
    const corp = await compuneSauDegradat<{ status: string; motiv?: string }>(
      () => {
        throw new Error('citire sincronă a lanțului eșuată');
      },
      (motiv) => ({ status: 'degraded', motiv }),
    );
    expect(corp.status).toBe('degraded');
    expect(corp.motiv).toContain('lanțului');
  });

  test('o valoare aruncată care nu este Error este tot raportată', async () => {
    const corp = await compuneSauDegradat<{ motiv?: string }>(
      async () => {
        throw 'ENOENT';
      },
      (motiv) => ({ motiv }),
    );
    expect(corp.motiv).toBe('ENOENT');
  });
});

describe('măsurătoarea protejată', () => {
  test('o măsurătoare reușită este întoarsă intactă, inclusiv zero', () => {
    expect(masoaraSauNecunoscut(() => 42)).toBe(42);
    // Zero e o măsurătoare validă: un lanț gol. Nu trebuie confundat cu eșecul.
    expect(masoaraSauNecunoscut(() => 0)).toBe(0);
  });

  test('o măsurătoare eșuată dă necunoscut, nu un zero plauzibil', () => {
    const motive: string[] = [];
    const rezultat = masoaraSauNecunoscut<number>(
      () => {
        throw new Error('baza de date locală e blocată');
      },
      (motiv) => motive.push(motiv),
    );
    // Un zero fabricat ar fi citit ca lanț gol, adică o afirmație despre pista de
    // audit pe care o citire eșuată nu o poate susține.
    expect(rezultat).toBeUndefined();
    expect(motive).toEqual(['baza de date locală e blocată']);
  });

  test('eșecul este semnalat chiar și fără observator', () => {
    expect(
      masoaraSauNecunoscut(() => {
        throw new Error('x');
      }),
    ).toBeUndefined();
  });
});
