/**
 * R-Knowledge — Deterministic Embedding Tests
 * MIP-014 STEP 2 · Phase 2 · Gate G2
 *
 * Gate G2 requires bitwise-identical vectors across 100 runs and across two
 * separate processes, the deterministic provider as the default with a null
 * model, a dimension-mismatch refusal, and zero network egress.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DeterministicEmbeddingAdapter,
  cosineSimilarity,
} from '../../src/knowledge/embedding/deterministic-adapter';
import {
  createEmbeddingAdapter,
  verifyEmbeddingDimensions,
} from '../../src/knowledge/embedding/embedding-adapter';
import { resolveKnowledgeConfig } from '../../src/planes/r-knowledge/config';
import { computeVectorHash } from '../../src/knowledge/schema';

const DIMENSIONS = 384;
const TEXT = 'Frequency containment reserve delivery from the 20 MWh Romania BESS installation.';

describe('R-Knowledge · deterministic embedder reproducibility (RK-019)', () => {
  test('the same text yields a bitwise identical vector across 100 runs', async () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const first = await adapter.embed([TEXT]);
    expect(first.ok).toBe(true);
    const referenceHash = computeVectorHash(first.vectors[0]);

    for (let run = 0; run < 100; run++) {
      const outcome = await adapter.embed([TEXT]);
      expect(outcome.vectors[0]).toEqual(first.vectors[0]);
      expect(computeVectorHash(outcome.vectors[0])).toBe(referenceHash);
    }
  });

  test('a freshly constructed adapter reproduces the same vector', async () => {
    const a = await new DeterministicEmbeddingAdapter(DIMENSIONS).embed([TEXT]);
    const b = await new DeterministicEmbeddingAdapter(DIMENSIONS).embed([TEXT]);
    expect(computeVectorHash(a.vectors[0])).toBe(computeVectorHash(b.vectors[0]));
  });

  test('vectors are identical in a second, separate process', () => {
    // Cross-process identity is the assertion that no in-process state, module
    // load order or memory layout participates in the vector.
    const dir = mkdtempSync(join(tmpdir(), 'ronor-embed-'));
    try {
      const script = join(dir, 'embed.js');
      writeFileSync(
        script,
        `
const { DeterministicEmbeddingAdapter } = require(${JSON.stringify(
          require.resolve('../../src/knowledge/embedding/deterministic-adapter')
        )});
const { createHash } = require('crypto');
function canonical(v){return '['+v.map(x=>JSON.stringify(x)).join(',')+']';}
(async () => {
  const a = new DeterministicEmbeddingAdapter(${DIMENSIONS});
  const r = await a.embed([${JSON.stringify(TEXT)}]);
  process.stdout.write(createHash('sha256').update(canonical(r.vectors[0]),'utf8').digest('hex'));
})();
`,
        'utf8'
      );

      const childHash = execFileSync(
        process.execPath,
        ['-r', require.resolve('ts-node/register'), script],
        { encoding: 'utf8', env: { ...process.env, TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' } }
      ).trim();

      const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
      return adapter.embed([TEXT]).then((local) => {
        expect(childHash).toHaveLength(64);
        expect(childHash).toBe(computeVectorHash(local.vectors[0]));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('the vector is L2-normalised and self-similarity is unity', async () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const { vectors } = await adapter.embed([TEXT]);
    const norm = Math.sqrt(vectors[0].reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 4);
    expect(cosineSimilarity(vectors[0], vectors[0])).toBeCloseTo(1, 5);
  });

  test('similarity is never reported above unity despite quantisation', async () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const { vectors } = await adapter.embed([TEXT, `${TEXT} `, TEXT.toUpperCase()]);
    for (const a of vectors) {
      for (const b of vectors) {
        const score = cosineSimilarity(a, b);
        expect(score).toBeLessThanOrEqual(1);
        expect(score).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  test('lexically related texts score above unrelated texts', async () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const { vectors } = await adapter.embed([
      'frequency containment reserve delivery from the BESS installation',
      'frequency containment reserve delivery obligations for the installation',
      'notarial deed transferring agricultural land in Ilfov county',
    ]);
    const related = cosineSimilarity(vectors[0], vectors[1]);
    const unrelated = cosineSimilarity(vectors[0], vectors[2]);
    expect(related).toBeGreaterThan(unrelated);
  });

  test('text without extractable features yields the zero vector, not a perturbation', async () => {
    const adapter = new DeterministicEmbeddingAdapter(8);
    const { vectors } = await adapter.embed(['']);
    expect(vectors[0]).toEqual(new Array(8).fill(0));
  });

  test('embedding does not depend on the host locale', async () => {
    const original = process.env.LANG;
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    try {
      process.env.LANG = 'tr_TR.UTF-8';
      const turkish = await adapter.embed(['INSTALLATION']);
      process.env.LANG = 'en_GB.UTF-8';
      const english = await adapter.embed(['INSTALLATION']);
      expect(computeVectorHash(turkish.vectors[0])).toBe(computeVectorHash(english.vectors[0]));
    } finally {
      if (original === undefined) delete process.env.LANG;
      else process.env.LANG = original;
    }
  });
});

describe('R-Knowledge · adapter contract properties (RK-018)', () => {
  test('the deterministic adapter declares no model and requires no egress', () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    expect(adapter.id).toBe('deterministic');
    expect(adapter.model).toBeNull();
    expect(adapter.requiresEgress).toBe(false);
    expect(adapter.requiresCredentials).toBe(false);
    expect(adapter.deterministic).toBe(true);
  });

  test('the default configuration produces the deterministic adapter', () => {
    const result = createEmbeddingAdapter(resolveKnowledgeConfig({}));
    expect(result.ok).toBe(true);
    expect(result.adapter?.id).toBe('deterministic');
    expect(result.adapter?.model).toBeNull();
  });

  test('initialisation refuses a non-positive dimension rather than throwing', async () => {
    const outcome = await new DeterministicEmbeddingAdapter(0).init();
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('CONFIG_INVALID');
  });
});

describe('R-Knowledge · embedding egress gate (RK-008)', () => {
  test('an external adapter is refused when egress is unauthorised, and no client is constructed', () => {
    const result = createEmbeddingAdapter(
      resolveKnowledgeConfig({
        KNOWLEDGE_EMBEDDING_PROVIDER: 'external',
        KNOWLEDGE_EMBEDDING_MODEL: 'some-model',
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_EGRESS_UNAUTHORISED');
    expect(result.adapter).not.toBeNull();
  });

  test('the refusing adapter refuses every call rather than throwing', async () => {
    const result = createEmbeddingAdapter(
      resolveKnowledgeConfig({ KNOWLEDGE_EMBEDDING_PROVIDER: 'external' })
    );
    const adapter = result.adapter!;
    const init = await adapter.init();
    const embed = await adapter.embed(['anything']);
    const health = await adapter.health();
    expect(init.ok).toBe(false);
    expect(embed.ok).toBe(false);
    expect(embed.vectors).toHaveLength(0);
    expect(health.available).toBe(false);
    expect(health.lastErrorCode).toBe('EMBEDDING_EGRESS_UNAUTHORISED');
  });

  test('egress authorisation alone does not create an implementation', () => {
    const result = createEmbeddingAdapter(
      resolveKnowledgeConfig({
        KNOWLEDGE_EMBEDDING_PROVIDER: 'external',
        KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
        KNOWLEDGE_EMBEDDING_MODEL: 'some-model',
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_UNAVAILABLE');
  });

  test('an external provider without a model is refused before egress is considered', () => {
    const result = createEmbeddingAdapter(
      resolveKnowledgeConfig({
        KNOWLEDGE_EMBEDDING_PROVIDER: 'external',
        KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
      })
    );
    expect(result.reason).toBe('EMBEDDING_MODEL_ABSENT');
  });

  test('a local provider is refused rather than silently substituted', () => {
    const result = createEmbeddingAdapter(
      resolveKnowledgeConfig({ KNOWLEDGE_EMBEDDING_PROVIDER: 'local' })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_MODEL_ABSENT');
    expect(result.adapter?.id).toBe('local');
    // Critically, not 'deterministic': a configured provider is never a fiction.
    expect(result.adapter?.id).not.toBe('deterministic');
  });
});

describe('R-Knowledge · dimensional agreement (K-INV-4)', () => {
  test('a wrong-dimension vector is refused, never coerced', () => {
    const verdict = verifyEmbeddingDimensions([new Array(128).fill(0)], 384);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('EMBEDDING_DIMENSION_MISMATCH');
    expect(verdict.detail).toContain('128');
    expect(verdict.detail).toContain('384');
  });

  test('matching dimensions are admitted', async () => {
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const { vectors } = await adapter.embed([TEXT, 'second text']);
    expect(verifyEmbeddingDimensions(vectors, DIMENSIONS).ok).toBe(true);
  });
});
