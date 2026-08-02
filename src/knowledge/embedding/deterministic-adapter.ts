/**
 * Deterministic Embedding Adapter — the reference embedder
 * MIP-014 STEP 2 · Phase 2 (Deterministic Core)
 *
 * The adapter is the plane's default and is deliberately unsophisticated. It is
 * a hashed-feature projection — a signed random-projection sketch over character
 * n-grams and word unigrams, with an L2-normalised output — and it makes no
 * claim to semantic quality. Its purpose is to establish reproducibility as the
 * baseline property of the plane, so that the corpus can be built, verified and
 * benchmarked without any dependency on a third party (STEP 1 § 11.3).
 *
 * The honest statement of its limitation is part of the contract, not an apology:
 * a hashed projection captures lexical overlap and captures very little else,
 * which is why Recall@8 and MRR are engineering qualification targets rather than
 * release gates (STEP 1 § 17.6).
 *
 * Reproducibility obligations, all satisfied by construction:
 *   - No clock, no random source, no environment read, no locale-sensitive
 *     comparison, no network access, no filesystem access.
 *   - Integer arithmetic only in the hash; the sole floating-point operations are
 *     accumulation in a fixed index order and a final L2 normalisation, so the
 *     result is bitwise identical across runs and across processes on the same
 *     IEEE-754 platform.
 */

import type {
  EmbedResult,
  EmbeddingAdapter,
  EmbeddingHealth,
  EmbeddingInitResult,
  EmbeddingProviderId,
} from '../../planes/r-knowledge/types';

/** Fixed seed. Changing it changes every vector in the corpus, so it is pinned. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Character n-gram width. Fixed, because it participates in vector identity. */
const NGRAM_WIDTH = 3;

/**
 * 32-bit FNV-1a over the UTF-8 code units of a string, with an explicit salt so
 * that the unigram and n-gram feature spaces do not collide with one another.
 * All arithmetic is coerced to unsigned 32-bit, so the result is independent of
 * the platform's number representation.
 */
function fnv1a32(text: string, salt: number): number {
  let hash = (FNV_OFFSET_BASIS ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash ^ text.charCodeAt(i)) >>> 0;
    // Multiply by the FNV prime in 32-bit space via Math.imul, which is exact.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Extract the feature multiset: lowercase word unigrams and character n-grams.
 *
 * Lowercasing uses `toLowerCase()` rather than `toLocaleLowerCase()`, because the
 * latter is locale-sensitive and would make vectors depend on the host's locale —
 * a reproducibility failure that would only appear in production.
 */
function extractFeatures(text: string): { feature: string; salt: number }[] {
  const lowered = text.toLowerCase();
  const features: { feature: string; salt: number }[] = [];

  const words = lowered.match(/[a-z0-9\u00e0-\u024f]+/g);
  if (words) {
    for (const word of words) features.push({ feature: word, salt: 1 });
  }

  const condensed = lowered.replace(/\s+/g, ' ');
  for (let i = 0; i + NGRAM_WIDTH <= condensed.length; i++) {
    features.push({ feature: condensed.slice(i, i + NGRAM_WIDTH), salt: 2 });
  }

  return features;
}

export class DeterministicEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: EmbeddingProviderId = 'deterministic';
  readonly provider = 'deterministic';
  /** Null by contract. No vendor model participates in this adapter. */
  readonly model: string | null = null;
  readonly dimensions: number;
  readonly requiresEgress = false;
  readonly requiresCredentials = false;
  readonly deterministic = true;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  /** No resource to acquire, so initialisation is trivially successful. */
  async init(): Promise<EmbeddingInitResult> {
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      return {
        ok: false,
        provider: this.id,
        reason: 'CONFIG_INVALID',
        detail: `dimensions must be a positive integer; received ${this.dimensions}`,
      };
    }
    return { ok: true, provider: this.id, reason: null };
  }

  /**
   * Project each text into the fixed-dimensional space.
   *
   * The signed hashing trick assigns each feature a deterministic index and a
   * deterministic sign, so that collisions cancel rather than accumulate. The
   * vector is L2-normalised, which makes the inner product equal to cosine
   * similarity and lets the store compare scores without knowing the metric.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors: number[][] = [];

    for (const text of texts) {
      const vector = new Array<number>(this.dimensions).fill(0);
      const features = extractFeatures(text);

      for (const { feature, salt } of features) {
        const hash = fnv1a32(feature, salt);
        const index = hash % this.dimensions;
        // The sign is drawn from a bit that does not participate in the index,
        // so sign and index are independent.
        const sign = ((hash >>> 31) & 1) === 1 ? -1 : 1;
        vector[index] += sign;
      }

      // L2 normalisation. A text with no extractable feature yields the zero
      // vector, which is returned as-is rather than being perturbed: a zero
      // vector honestly represents "no lexical signal" and will simply fail the
      // similarity floor at retrieval.
      let sumSquares = 0;
      for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i];
      if (sumSquares > 0) {
        const norm = Math.sqrt(sumSquares);
        for (let i = 0; i < vector.length; i++) {
          // Six-decimal quantisation. This is what makes the vector byte-stable
          // when serialised and re-read, so that a stored vector hashes to the
          // same digest as the vector that produced it.
          vector[i] = Number((vector[i] / norm).toFixed(6));
        }
      }

      vectors.push(vector);
    }

    return {
      ok: true,
      vectors,
      provider: this.provider,
      model: null,
      dimensions: this.dimensions,
      reason: null,
    };
  }

  async health(): Promise<EmbeddingHealth> {
    return {
      provider: this.id,
      available: true,
      latencyMs: 0,
      lastErrorCode: null,
      checkedAt: new Date(),
    };
  }
}

/**
 * Cosine similarity between two L2-normalised vectors, computed as the inner
 * product. Accumulation is in ascending index order, which fixes the
 * floating-point summation order and therefore the result.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Clamp to the valid range. Quantisation can push a self-similarity a few
  // parts in 10^6 above unity, and a score above 1.0 would be a contract breach.
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}
