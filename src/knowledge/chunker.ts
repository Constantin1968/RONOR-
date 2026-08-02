/**
 * Deterministic Chunker
 * MIP-014 STEP 2 · Phase 2 (Deterministic Core)
 *
 * Chunking is byte-stable: the same input, under the same configuration, yields
 * the same chunk boundaries and therefore the same content digests on every run,
 * in every process, on every host (RK-013, K-INV-5).
 *
 * Determinism here is not a convenience. The content digest of a chunk is the
 * corpus's identity mechanism, so a chunker whose boundaries drifted would
 * silently produce duplicate objects with different identities and would defeat
 * duplicate detection at I-8. The implementation therefore contains no source of
 * non-determinism whatsoever: no clock, no random value, no locale-sensitive
 * comparison, no iteration over unordered structures and no floating-point
 * accumulation that could vary in order.
 */

// ------------------------------------------------------------
// Normalisation — pipeline stage I-5
// ------------------------------------------------------------

/**
 * Control characters removed during normalisation. Each is invisible when
 * rendered, which is precisely why each is a carrier for a hidden payload: two
 * visually identical documents could otherwise differ in content and in digest
 * (STEP 1 § 12.2, control-character neutralisation).
 *
 *   U+200B..U+200D  zero-width space, non-joiner, joiner
 *   U+200E, U+200F  left-to-right and right-to-left marks
 *   U+202A..U+202E  bidirectional embedding and override
 *   U+2060          word joiner
 *   U+2066..U+2069  bidirectional isolates
 *   U+FEFF          byte-order mark / zero-width no-break space
 *   U+00AD          soft hyphen
 *   U+0000..U+0008, U+000B, U+000C, U+000E..U+001F  C0 controls except \t \n \r
 */
const INVISIBLE_AND_CONTROL =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface NormalisationResult {
  text: string;
  /** Count of invisible or control characters removed. Reported, not hidden. */
  charactersRemoved: number;
  /** True when normalisation altered the input in any way. */
  altered: boolean;
}

/**
 * Normalise text for hashing and chunking.
 *
 * Order matters and is fixed: Unicode NFC composition first, so that
 * canonically equivalent sequences converge; then removal of invisible and
 * control characters, so that a payload cannot survive as a decomposed form;
 * then line-ending normalisation; then collapse of horizontal whitespace runs;
 * then trimming. Reversing any two steps would change the output for some input,
 * so the order is part of the contract.
 */
export function normaliseText(input: string): NormalisationResult {
  const composed = input.normalize('NFC');
  const stripped = composed.replace(INVISIBLE_AND_CONTROL, '');
  const charactersRemoved = composed.length - stripped.length;

  const unixEndings = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Collapse horizontal whitespace runs, but preserve paragraph structure,
  // because paragraph boundaries are the chunker's preferred split points.
  const collapsedHorizontal = unixEndings.replace(/[ \t\f\v]+/g, ' ');
  const collapsedVertical = collapsedHorizontal.replace(/\n{3,}/g, '\n\n');
  const text = collapsedVertical
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  return {
    text,
    charactersRemoved,
    altered: text !== input,
  };
}

// ------------------------------------------------------------
// Token estimation
// ------------------------------------------------------------

/**
 * Token count estimator.
 *
 * The estimate is deliberately a whitespace-and-punctuation segmentation rather
 * than a vendor tokeniser. A vendor tokeniser would introduce a dependency, tie
 * chunk boundaries to a third party's versioning, and make the corpus's identity
 * mechanism a function of that party's release schedule. The estimator is
 * therefore approximate by design and exact in its reproducibility, which is the
 * property that matters (STEP 1 § 11.1, vendor independence).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const segments = text.match(/[A-Za-z0-9\u00C0-\u024F]+|[^\sA-Za-z0-9\u00C0-\u024F]/g);
  if (!segments) return 0;
  let tokens = 0;
  for (const segment of segments) {
    // Long alphanumeric runs are counted in four-character units, which
    // approximates sub-word segmentation without importing one.
    tokens += segment.length > 4 ? Math.ceil(segment.length / 4) : 1;
  }
  return tokens;
}

// ------------------------------------------------------------
// Chunking
// ------------------------------------------------------------

export interface ChunkOptions {
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
}

export interface Chunk {
  index: number;
  total: number;
  text: string;
  tokenEstimate: number;
  /** Character offsets into the normalised text; half-open interval. */
  startOffset: number;
  endOffset: number;
}

export interface ChunkOutcome {
  ok: boolean;
  chunks: Chunk[];
  normalised: NormalisationResult;
  detail?: string;
}

/**
 * Split normalised text into overlapping chunks at deterministic boundaries.
 *
 * Boundary selection is greedy and preference-ordered: a paragraph break is
 * preferred to a sentence break, a sentence break to a word break, and a word
 * break to a hard character cut. A hard cut is used only when no softer boundary
 * exists within the window, which guarantees termination for pathological input
 * such as a single unbroken 100,000-character run.
 */
export function chunkText(input: string, options: ChunkOptions): ChunkOutcome {
  const normalised = normaliseText(input);

  if (options.chunkOverlapTokens >= options.chunkSizeTokens) {
    return {
      ok: false,
      chunks: [],
      normalised,
      detail: 'chunk overlap must be strictly smaller than chunk size',
    };
  }
  if (normalised.text.length === 0) {
    return { ok: false, chunks: [], normalised, detail: 'content is empty after normalisation' };
  }

  const text = normalised.text;
  // Characters-per-token ratio implied by the estimator, used to size the
  // search window. A fixed constant, so window sizing is deterministic.
  const CHARS_PER_TOKEN = 4;
  const windowChars = Math.max(16, options.chunkSizeTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, options.chunkOverlapTokens * CHARS_PER_TOKEN);

  const raw: { text: string; startOffset: number; endOffset: number }[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= windowChars) {
      raw.push({ text: text.slice(cursor), startOffset: cursor, endOffset: text.length });
      break;
    }

    const hardLimit = cursor + windowChars;
    // Search backwards from the hard limit for the best boundary, but never
    // accept a boundary in the first half of the window, because doing so would
    // produce chunks far below target size and inflate the object count.
    const floor = cursor + Math.floor(windowChars / 2);
    const window = text.slice(cursor, hardLimit);

    let cut = -1;
    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= 0 && cursor + paragraph + 2 > floor) {
      cut = cursor + paragraph + 2;
    }
    if (cut < 0) {
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('.\n'),
        window.lastIndexOf('? '),
        window.lastIndexOf('! ')
      );
      if (sentence >= 0 && cursor + sentence + 2 > floor) cut = cursor + sentence + 2;
    }
    if (cut < 0) {
      const newline = window.lastIndexOf('\n');
      if (newline >= 0 && cursor + newline + 1 > floor) cut = cursor + newline + 1;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      if (space >= 0 && cursor + space + 1 > floor) cut = cursor + space + 1;
    }
    // Hard cut: no softer boundary exists in the admissible half-window.
    if (cut < 0) cut = hardLimit;

    raw.push({ text: text.slice(cursor, cut), startOffset: cursor, endOffset: cut });

    const advance = cut - cursor - overlapChars;
    // Strict monotonic progress. Without this floor an overlap larger than the
    // achieved chunk length would loop forever.
    cursor += advance > 0 ? advance : cut - cursor;
  }

  const total = raw.length;
  const chunks: Chunk[] = raw.map((piece, index) => ({
    index,
    total,
    text: piece.text.trim(),
    tokenEstimate: estimateTokens(piece.text),
    startOffset: piece.startOffset,
    endOffset: piece.endOffset,
  }));

  return { ok: true, chunks, normalised };
}

/**
 * Whether a chunk set forms a gapless cover of its parent document (K-INV-5).
 * A cover is gapless when the indices are exactly 0..total-1, each appearing
 * once, and every chunk agrees on the total.
 */
export function isGaplessCover(chunks: readonly Chunk[]): boolean {
  if (chunks.length === 0) return false;
  const total = chunks[0].total;
  if (chunks.length !== total) return false;
  if (!chunks.every((c) => c.total === total)) return false;
  const seen = new Set<number>();
  for (const chunk of chunks) {
    if (chunk.index < 0 || chunk.index >= total) return false;
    if (seen.has(chunk.index)) return false;
    seen.add(chunk.index);
  }
  return seen.size === total;
}
