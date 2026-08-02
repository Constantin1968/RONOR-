/**
 * R-Knowledge Retrieval Benchmark
 * MIP-014 STEP 2 · Phase 7 · Gate G7
 *
 * Measures the R-Knowledge retrieval path against a labelled corpus and emits a
 * machine-readable report with an explicit verdict per metric class.
 *
 * THREE CLASSES OF METRIC, WITH DIFFERENT AUTHORITY
 *
 *   RELEASE GATE (no waiver available)
 *     Citation accuracy         must equal 1.000
 *     Provenance completeness   must equal 1.000
 *   These are CONTRACTUAL. They are properties the implementation either has or
 *   does not have, and a shortfall blocks release outright.
 *
 *   QUALIFICATION (verdict recorded, release not blocked)
 *     Recall@8   >= 0.60
 *     MRR        >= 0.50
 *   These determine whether the plane is qualified for OPERATIONAL RETRIEVAL. A
 *   shortfall refuses that qualification while permitting release as experimental
 *   infrastructure (STEP 1 § 17.6).
 *
 *   OBSERVATIONAL (no verdict)
 *     P95 latency, zero-result rate, host specification
 *   Recorded because they are useful, and given no threshold because a threshold
 *   measured on one unspecified host would be a number pretending to be a standard.
 *
 * Run:  npx ts-node scripts/benchmark-retrieval.ts
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { cpus, totalmem, platform, release } from 'os';

import { RKnowledgePlane } from '../src/planes/r-knowledge';

const REPO_ROOT = join(__dirname, '..');
const CORPUS_PATH = join(REPO_ROOT, 'benchmarks', 'knowledge', 'corpus.json');
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'knowledge');
const DB_PATH = '/tmp/ronor-benchmark-knowledge.db';

const K = 8;

interface CorpusDocument {
  id: string;
  title: string;
  sourceUri: string;
  sourceType: string;
  classification: string;
  content: string;
}

interface CorpusQuery {
  id: string;
  query: string;
  relevant: string[];
  lexicalOverlap: 'high' | 'medium' | 'low';
}

interface Corpus {
  corpusVersion: string;
  documents: CorpusDocument[];
  queries: CorpusQuery[];
}

interface QueryOutcome {
  queryId: string;
  query: string;
  lexicalOverlap: string;
  relevant: string[];
  retrievedParents: string[];
  hit: boolean;
  reciprocalRank: number;
  resultCount: number;
  latencyMs: number;
  reason: string | null;
  citationsResolved: number;
  citationsTotal: number;
  provenanceCompleteCount: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function main(): Promise<number> {
  const corpus: Corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

  // A fresh store for every run, so a result can never be inherited from a
  // previous run's residue.
  if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });

  const plane = RKnowledgePlane.create({
    KNOWLEDGE_ENABLED: 'true',
    KNOWLEDGE_VECTOR_STORE: 'sqlite',
    KNOWLEDGE_SQLITE_PATH: DB_PATH,
    KNOWLEDGE_ENVIRONMENT_CLASS: 'test',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '384',
    KNOWLEDGE_RETRIEVAL_TOP_K: String(K),
    KNOWLEDGE_MIN_SIMILARITY: '0.0',
    KNOWLEDGE_MAX_CLASSIFICATION: 'INTERNAL',
  });

  if (plane === null) {
    throw new Error('plane construction refused; the benchmark cannot proceed');
  }

  await plane.init();

  // ---------- Ingestion ----------
  const ingestionLatencies: number[] = [];
  let chunksIngested = 0;
  const parentIdByDocument = new Map<string, string>();

  for (const document of corpus.documents) {
    const started = process.hrtime.bigint();
    const result = await plane.ingestDocument({
      content: document.content,
      sourceUri: document.sourceUri,
      sourceType: document.sourceType,
      classification: document.classification,
      sovereigntyTier: 1,
      ingestedBy: 'benchmark',
      parentDocumentId: document.id,
      title: document.title,
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
    ingestionLatencies.push(elapsed);

    if (!result.ok) {
      throw new Error(`ingestion of ${document.id} failed: ${result.reason} ${result.detail}`);
    }
    chunksIngested += result.objectIds.length;
    parentIdByDocument.set(document.id, document.id);
  }

  // ---------- Retrieval ----------
  const outcomes: QueryOutcome[] = [];

  for (const query of corpus.queries) {
    const started = process.hrtime.bigint();
    const response = await plane.query({ query: query.query, k: K });
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    // The parent document of each result, in rank order, deduplicated while
    // preserving the best rank for each parent. Relevance is judged at DOCUMENT
    // level, so two chunks of the same document must not count as two hits.
    const retrievedParents: string[] = [];
    for (const result of response.results) {
      const parent = result.object.provenance.parentDocumentId;
      if (!retrievedParents.includes(parent)) retrievedParents.push(parent);
    }

    const firstRelevantIndex = retrievedParents.findIndex((parent) =>
      query.relevant.includes(parent)
    );

    // Citation accuracy: every returned citation must be non-empty, must follow the
    // declared grammar, and must resolve to the object it accompanies. A citation
    // that resolves to a DIFFERENT object is the failure mode that matters, because
    // it attributes a claim to the wrong source.
    //
    // The grammar is a BRACKETED label: `[PARENT-STEM-C001]`, not the bare label.
    // My first version compared the citation to the bare `citationLabel` and scored
    // 0.000 on a release gate that admits no waiver. That was a defect in the
    // measurement, not in the implementation — and it is worth noting that a
    // measurement defect on a no-waiver gate is the most dangerous kind, because the
    // obvious response to a failing contractual metric is to change the code.
    let citationsResolved = 0;
    for (const result of response.results) {
      const expected = `[${result.object.provenance.citationLabel}]`;
      if (
        typeof result.citation === 'string' &&
        result.citation.length > 0 &&
        result.citation === expected &&
        /^\[[A-Z0-9-]+-C\d{3}\]$/.test(result.citation)
      ) {
        citationsResolved += 1;
      }
    }

    outcomes.push({
      queryId: query.id,
      query: query.query,
      lexicalOverlap: query.lexicalOverlap,
      relevant: query.relevant,
      retrievedParents,
      hit: firstRelevantIndex !== -1,
      reciprocalRank: firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
      resultCount: response.results.length,
      latencyMs,
      reason: response.reason,
      citationsResolved,
      citationsTotal: response.results.length,
      provenanceCompleteCount: response.results.filter((r) => r.provenanceComplete).length,
    });
  }

  await plane.shutdown();
  rmSync(DB_PATH, { force: true });

  // ---------- Metrics ----------
  const queryCount = outcomes.length;
  const recallAtK = outcomes.filter((o) => o.hit).length / queryCount;
  const mrr = outcomes.reduce((sum, o) => sum + o.reciprocalRank, 0) / queryCount;

  // Recall@1, reported alongside Recall@8 because Recall@8 over a 12-document corpus
  // is a WEAK measure: retrieving eight of twelve documents means a query need only
  // avoid ranking the right document in the bottom third. Recall@1 cannot be
  // satisfied by breadth and is therefore the number that discriminates. Reporting
  // only the flattering metric would be the kind of selective presentation that
  // makes a benchmark useless.
  const recallAt1 =
    outcomes.filter((o) => o.reciprocalRank === 1).length / queryCount;

  // The proportion of the corpus returned at k. A value near 1 signals that the
  // Recall@k threshold is close to vacuous for this corpus size.
  const corpusFractionAtK = Math.min(1, K / corpus.documents.length);

  const citationsTotal = outcomes.reduce((sum, o) => sum + o.citationsTotal, 0);
  const citationsResolved = outcomes.reduce((sum, o) => sum + o.citationsResolved, 0);
  const citationAccuracy = citationsTotal === 0 ? 0 : citationsResolved / citationsTotal;

  const provenanceComplete = outcomes.reduce((sum, o) => sum + o.provenanceCompleteCount, 0);
  const provenanceCompleteness = citationsTotal === 0 ? 0 : provenanceComplete / citationsTotal;

  const latencies = outcomes.map((o) => o.latencyMs);
  const zeroResultRate = outcomes.filter((o) => o.resultCount === 0).length / queryCount;

  // Breakdown by lexical overlap. This is the diagnostic that explains a Recall
  // shortfall rather than merely reporting one, and it is the reason the corpus
  // labels overlap in the first place.
  const byOverlap: Record<string, { queries: number; recall: number; mrr: number }> = {};
  for (const band of ['high', 'medium', 'low']) {
    const subset = outcomes.filter((o) => o.lexicalOverlap === band);
    if (subset.length === 0) continue;
    byOverlap[band] = {
      queries: subset.length,
      recall: round(subset.filter((o) => o.hit).length / subset.length),
      mrr: round(subset.reduce((sum, o) => sum + o.reciprocalRank, 0) / subset.length),
    };
  }

  // ---------- Verdicts ----------
  const releaseGate = [
    {
      metric: 'citation_accuracy',
      value: round(citationAccuracy),
      threshold: 1.0,
      comparator: '=',
      result: citationAccuracy === 1 ? 'PASS' : 'FAIL',
      waivable: false,
    },
    {
      metric: 'provenance_completeness',
      value: round(provenanceCompleteness),
      threshold: 1.0,
      comparator: '=',
      result: provenanceCompleteness === 1 ? 'PASS' : 'FAIL',
      waivable: false,
    },
  ];

  const qualification = [
    {
      metric: 'recall_at_8',
      value: round(recallAtK),
      threshold: 0.6,
      comparator: '>=',
      result: recallAtK >= 0.6 ? 'PASS' : 'FAIL',
    },
    {
      metric: 'mrr',
      value: round(mrr),
      threshold: 0.5,
      comparator: '>=',
      result: mrr >= 0.5 ? 'PASS' : 'FAIL',
    },
  ];

  const releaseVerdict = releaseGate.every((m) => m.result === 'PASS') ? 'PASS' : 'FAIL';
  const qualificationVerdict = qualification.every((m) => m.result === 'PASS')
    ? 'QUALIFIED'
    : 'NOT QUALIFIED';

  const report = {
    gate: 'G7',
    benchmark: 'R-Knowledge retrieval',
    corpusVersion: corpus.corpusVersion,
    documents: corpus.documents.length,
    chunksIngested,
    queries: queryCount,
    k: K,
    embeddingProvider: 'deterministic',
    storeId: 'sqlite',
    releaseGate: {
      verdict: releaseVerdict,
      note: 'Contractual. No waiver is available for either metric.',
      metrics: releaseGate,
    },
    operationalQualification: {
      verdict: qualificationVerdict,
      note:
        'Determines qualification for OPERATIONAL RETRIEVAL. A shortfall refuses that ' +
        'qualification and does NOT block release as experimental infrastructure ' +
        '(STEP 1 § 17.6).',
      metrics: qualification,
    },
    qualificationCaveat: {
      recallAt1: round(recallAt1),
      corpusFractionReturnedAtK: round(corpusFractionAtK),
      note:
        `Recall@${K} over a ${corpus.documents.length}-document corpus returns ` +
        `${round(corpusFractionAtK * 100, 1)}% of the corpus, so the >= 0.60 threshold is ` +
        'weak here: a query need only avoid ranking the relevant document in the bottom ' +
        'third. Recall@1 cannot be satisfied by breadth and is the discriminating number. ' +
        'The PASS verdict above should be read as conditional on corpus scale, and ' +
        're-measured on a corpus at least an order of magnitude larger before it is relied ' +
        'upon for an operational decision.',
    },
    observational: {
      note: 'No verdict. Host-dependent, recorded with the host specification.',
      p50LatencyMs: round(percentile(latencies, 50), 2),
      p95LatencyMs: round(percentile(latencies, 95), 2),
      maxLatencyMs: round(Math.max(...latencies), 2),
      p95IngestionMs: round(percentile(ingestionLatencies, 95), 2),
      zeroResultRate: round(zeroResultRate),
      host: {
        platform: `${platform()} ${release()}`,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemoryGb: round(totalmem() / 1024 ** 3, 1),
        nodeVersion: process.version,
      },
    },
    diagnosticByLexicalOverlap: byOverlap,
    perQuery: outcomes.map((o) => ({
      queryId: o.queryId,
      query: o.query,
      lexicalOverlap: o.lexicalOverlap,
      relevant: o.relevant,
      hit: o.hit,
      reciprocalRank: round(o.reciprocalRank),
      topParents: o.retrievedParents.slice(0, 3),
      resultCount: o.resultCount,
      reason: o.reason,
      latencyMs: round(o.latencyMs, 2),
    })),
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, 'benchmark-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );

  // ---------- Console summary ----------
  console.log('\n=========================================================');
  console.log('R-KNOWLEDGE RETRIEVAL BENCHMARK · Gate G7');
  console.log('=========================================================');
  console.log(`corpus ${corpus.corpusVersion} · ${corpus.documents.length} documents · ${chunksIngested} chunks · ${queryCount} queries · k=${K}`);
  console.log('\nRELEASE GATE (contractual, no waiver)');
  for (const m of releaseGate) {
    console.log(`  ${m.result.padEnd(5)} ${m.metric.padEnd(26)} ${m.value.toFixed(3)} ${m.comparator} ${m.threshold.toFixed(3)}`);
  }
  console.log(`  => ${releaseVerdict}`);
  console.log('\nOPERATIONAL QUALIFICATION (verdict recorded, release not blocked)');
  for (const m of qualification) {
    console.log(`  ${m.result.padEnd(5)} ${m.metric.padEnd(26)} ${m.value.toFixed(3)} ${m.comparator} ${m.threshold.toFixed(3)}`);
  }
  console.log(`  => ${qualificationVerdict}`);
  console.log('\n  CAVEAT ON THE ABOVE');
  console.log(`    recall_at_1                 ${recallAt1.toFixed(3)}   (no threshold; the discriminating number)`);
  console.log(`    corpus fraction at k=${K}      ${corpusFractionAtK.toFixed(3)}   (k returns this share of the corpus)`);
  console.log(`    Recall@${K} is a WEAK measure at this corpus size. Re-measure at scale.`);
  console.log('\nOBSERVATIONAL (no verdict)');
  console.log(`  p50 latency ${report.observational.p50LatencyMs} ms · p95 ${report.observational.p95LatencyMs} ms · max ${report.observational.maxLatencyMs} ms`);
  console.log(`  zero-result rate ${report.observational.zeroResultRate}`);
  console.log(`  host ${report.observational.host.cpuCount} vCPU · ${report.observational.host.totalMemoryGb} GB · node ${report.observational.host.nodeVersion}`);
  console.log('\nDIAGNOSTIC · recall by query/document lexical overlap');
  for (const [band, stats] of Object.entries(byOverlap)) {
    console.log(`  ${band.padEnd(7)} n=${String(stats.queries).padEnd(3)} recall ${stats.recall.toFixed(3)} · mrr ${stats.mrr.toFixed(3)}`);
  }
  console.log('\nwrote evidence/knowledge/benchmark-report.json');
  console.log('=========================================================\n');

  // The RELEASE GATE determines the exit code. Qualification does not: a refusal of
  // operational qualification is a recorded verdict, not a build failure, and
  // conflating the two would either block a permitted release or silently pass an
  // unqualified one.
  return releaseVerdict === 'PASS' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('benchmark failed:', error);
    process.exit(1);
  });
