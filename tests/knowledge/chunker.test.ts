/**
 * R-Knowledge — Deterministic Chunker Tests
 * MIP-014 STEP 2 · Phase 2 · Gate G2
 *
 * Gate G2 requires byte-stable chunking across 100 runs, gapless chunk cover,
 * and neutralisation of invisible and control characters during normalisation.
 */

import {
  chunkText,
  estimateTokens,
  isGaplessCover,
  normaliseText,
} from '../../src/knowledge/chunker';
import { computeContentHash } from '../../src/knowledge/schema';

const OPTIONS = { chunkSizeTokens: 64, chunkOverlapTokens: 8 };

const DOCUMENT = [
  'The Romania battery energy storage facility operates a 20 MWh installation.',
  'Dispatch is governed by a day-ahead schedule with intraday correction.',
  '',
  'State of charge is maintained between fifteen and ninety percent to preserve cycle life.',
  'Thermal management uses liquid cooling with a setpoint of twenty-two degrees Celsius.',
  '',
  'Grid services provided include frequency containment reserve and automatic frequency restoration reserve.',
  'Revenue stacking combines capacity payments with energy arbitrage across the day-ahead and balancing markets.',
].join('\n');

describe('R-Knowledge · normalisation (I-5)', () => {
  test('zero-width and bidirectional control characters are removed', () => {
    const payload = 'visible\u200Bte\u200Ext\u202Ereversed\u2069\uFEFF';
    const result = normaliseText(payload);
    expect(result.text).toBe('visibletextreversed');
    expect(result.charactersRemoved).toBe(5);
    expect(result.altered).toBe(true);
  });

  test('two visually identical inputs converge to the same digest after normalisation', () => {
    const clean = normaliseText('frequency containment reserve');
    const hidden = normaliseText('frequency\u200B containment\u00AD reserve');
    expect(clean.text).toBe(hidden.text);
    expect(computeContentHash(clean.text)).toBe(computeContentHash(hidden.text));
  });

  test('C0 control characters other than tab, newline and carriage return are removed', () => {
    const result = normaliseText('alpha\u0000beta\u0007gamma\u001Fdelta');
    expect(result.text).toBe('alphabetagammadelta');
  });

  test('line endings are normalised and paragraph structure is preserved', () => {
    const result = normaliseText('one\r\ntwo\r\n\r\n\r\n\r\nthree');
    expect(result.text).toBe('one\ntwo\n\nthree');
  });

  test('normalisation is idempotent', () => {
    const once = normaliseText(DOCUMENT).text;
    const twice = normaliseText(once).text;
    expect(twice).toBe(once);
  });

  test('NFC composition converges canonically equivalent sequences', () => {
    const composed = normaliseText('café');
    const decomposed = normaliseText('cafe\u0301');
    expect(composed.text).toBe(decomposed.text);
  });
});

describe('R-Knowledge · token estimation', () => {
  test('estimation is deterministic and non-negative', () => {
    const first = estimateTokens(DOCUMENT);
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) expect(estimateTokens(DOCUMENT)).toBe(first);
    expect(estimateTokens('')).toBe(0);
  });

  test('the estimator names no vendor tokeniser', () => {
    // Vendor independence: chunk boundaries must not be a function of a third
    // party's release schedule.
    const source = estimateTokens.toString();
    expect(source).not.toMatch(/tiktoken|cl100k|gpt|openai/i);
  });
});

describe('R-Knowledge · chunk determinism (RK-013)', () => {
  test('identical input yields identical chunk digests across 100 runs', () => {
    const reference = chunkText(DOCUMENT, OPTIONS);
    expect(reference.ok).toBe(true);
    const referenceDigests = reference.chunks.map((c) => computeContentHash(c.text));

    for (let run = 0; run < 100; run++) {
      const outcome = chunkText(DOCUMENT, OPTIONS);
      expect(outcome.ok).toBe(true);
      expect(outcome.chunks).toHaveLength(reference.chunks.length);
      expect(outcome.chunks.map((c) => computeContentHash(c.text))).toEqual(referenceDigests);
      expect(outcome.chunks.map((c) => [c.startOffset, c.endOffset])).toEqual(
        reference.chunks.map((c) => [c.startOffset, c.endOffset])
      );
    }
  });

  test('chunk boundaries are stable under a long synthetic corpus', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the operational record. `)
      .join('\n\n');
    const a = chunkText(long, OPTIONS);
    const b = chunkText(long, OPTIONS);
    expect(a.chunks.map((c) => c.text)).toEqual(b.chunks.map((c) => c.text));
    expect(a.chunks.length).toBeGreaterThan(1);
  });

  test('chunk cover is gapless (K-INV-5)', () => {
    const outcome = chunkText(DOCUMENT, OPTIONS);
    expect(isGaplessCover(outcome.chunks)).toBe(true);
    expect(outcome.chunks.every((c) => c.total === outcome.chunks.length)).toBe(true);
    expect(outcome.chunks.map((c) => c.index)).toEqual(
      Array.from({ length: outcome.chunks.length }, (_, i) => i)
    );
  });

  test('an unbroken run terminates via a hard cut rather than looping', () => {
    const unbroken = 'A'.repeat(100_000);
    const outcome = chunkText(unbroken, { chunkSizeTokens: 32, chunkOverlapTokens: 4 });
    expect(outcome.ok).toBe(true);
    expect(outcome.chunks.length).toBeGreaterThan(1);
    expect(isGaplessCover(outcome.chunks)).toBe(true);
  });

  test('overlap not smaller than chunk size is refused rather than looping', () => {
    const outcome = chunkText(DOCUMENT, { chunkSizeTokens: 32, chunkOverlapTokens: 32 });
    expect(outcome.ok).toBe(false);
    expect(outcome.chunks).toHaveLength(0);
    expect(outcome.detail).toContain('overlap');
  });

  test('empty content after normalisation is refused', () => {
    const outcome = chunkText('\u200B\u200B\u200B', OPTIONS);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('empty');
  });

  test('a short document produces exactly one chunk', () => {
    const outcome = chunkText('A single short operational note.', OPTIONS);
    expect(outcome.ok).toBe(true);
    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.chunks[0].index).toBe(0);
    expect(outcome.chunks[0].total).toBe(1);
  });

  test('a partial cover is not gapless', () => {
    const outcome = chunkText(DOCUMENT, OPTIONS);
    if (outcome.chunks.length > 1) {
      expect(isGaplessCover(outcome.chunks.slice(1))).toBe(false);
    }
    expect(isGaplessCover([])).toBe(false);
  });
});
