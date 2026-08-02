# R-Knowledge Retrieval Benchmark Report

**Gate:** G7
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Harness:** `scripts/benchmark-retrieval.ts`
**Corpus:** `benchmarks/knowledge/corpus.json` v1.0 — 12 documents, 20 labelled queries
**Store:** SQLite reference adapter · **Embedder:** deterministic hashed projection
**Date:** 02 August 2026

## 1. Release gate — contractual, no waiver available

| Metric | Value | Threshold | Result |
|---|---|---|---|
| Citation accuracy | **1.000** | = 1.000 | PASS |
| Provenance completeness | **1.000** | = 1.000 | PASS |

**Verdict: PASS.**

These two metrics are properties the implementation either has or does not have. A
shortfall blocks release outright, and the harness's exit code is governed by these
two alone.

### A measurement defect I found and fixed, which matters more than the result

My first version of the citation check compared `result.citation` against the bare
`provenance.citationLabel`. The actual grammar is a **bracketed** label —
`[D01-GRID-C001]`, not `D01-GRID-C001` — so the check scored **0.000** on a release
gate that admits no waiver.

This is the most dangerous class of defect in the entire exercise, and it is worth
being explicit about why. A failing contractual metric invites exactly one response:
change the code until the number moves. Had I done that, I would have altered a
correct citation-binding implementation to satisfy a broken ruler, and the resulting
1.000 would have been a fabrication. The correct diagnosis was that the measurement
was wrong. The check now also asserts the grammar positively
(`/^\[[A-Z0-9-]+-C\d{3}\]$/`), so a future change to either side fails loudly rather
than silently agreeing.

## 2. Operational-retrieval qualification — verdict recorded, release not blocked

| Metric | Value | Threshold | Result |
|---|---|---|---|
| Recall@8 | **1.000** | ≥ 0.60 | PASS |
| MRR | **0.865** | ≥ 0.50 | PASS |

**Verdict: QUALIFIED.**

### This verdict must be read with the caveat attached, not separated from it

I predicted at G2 that the deterministic embedder would struggle here. It did not,
and I was wrong about that — but the reason it did not is partly an artefact of
corpus scale, and reporting the PASS without that context would be misleading.

| Diagnostic | Value |
|---|---|
| Recall@1 | **0.800** |
| Corpus fraction returned at k=8 | **0.667** |

**Recall@8 over a 12-document corpus returns two-thirds of the corpus.** A query need
only avoid ranking the relevant document in the bottom third to count as a hit, so
the ≥ 0.60 threshold is close to vacuous at this scale. Recall@1 cannot be satisfied
by breadth, and it is the number that discriminates: **0.800**, meaning four queries
in twenty failed to place the correct document first.

The harness therefore reports Recall@1 and the corpus fraction alongside the
threshold metrics, and the JSON report carries a `qualificationCaveat` block stating
that the PASS is **conditional on corpus scale** and should be re-measured on a
corpus at least an order of magnitude larger before it is relied upon for an
operational decision. Reporting only the flattering metric would make the benchmark
useless as evidence.

### Where the embedder actually is weak

The corpus labels each query by its lexical overlap with the document it should
retrieve, precisely so that a shortfall can be explained rather than merely reported.

| Lexical overlap | Queries | Recall@8 | MRR |
|---|---|---|---|
| High | 8 | 1.000 | 0.938 |
| Medium | 7 | 1.000 | 0.905 |
| Low | 5 | 1.000 | **0.692** |

The gradient is the finding. MRR falls from 0.938 to 0.692 as lexical overlap falls,
which is the signature of a hashed feature projection: it captures lexical
co-occurrence and very little semantic structure. The four Recall@1 misses cluster in
the low and medium bands:

| Query | Overlap | Reciprocal rank | Top-3 parents | Should have been |
|---|---|---|---|---|
| Q02 "what makes a battery lose capacity over time" | medium | 0.333 | D12, D06, D02 | D02 |
| Q07 "how does tamper evidence work in an append only log" | low | 0.333 | D01, D05, D07 | D07 |
| Q08 "who pays when a wind farm is told to switch off" | low | **0.125** | D01, D05, D06 | D08 |
| Q14 "shape risk and basis risk in offtake agreements" | high | 0.500 | D10, D03, D02 | D03 |

Q08 is the clearest case: the query uses "wind farm" and "switch off" where the
document says "renewable generator" and "reduce output". No lexical bridge exists, so
the correct document lands at rank eight. A learned embedding trained on paraphrase
would retrieve it; a hashed projection cannot.

**Conclusion on the embedder.** The deterministic adapter is fit for its stated
purpose — reproducible, zero-egress, dependency-free infrastructure verification —
and it is **not** fit for production retrieval over a corpus where users phrase
queries in their own words. That is a property of the design, chosen deliberately,
and not a defect to be fixed at this gate.

## 3. Observational — no verdict

Recorded because the numbers are useful; given no threshold because a latency
threshold measured once on one unspecified host would be a number pretending to be a
standard.

| Measure | Value |
|---|---|
| P50 query latency | 4.4 ms |
| P95 query latency | 8.1 ms |
| Max query latency | 8.2 ms |
| P95 ingestion latency | see `benchmark-report.json` |
| Zero-result rate | 0.000 |

**Host:** 6 vCPU, 3.8 GB RAM, Node v22.13.0, Linux. These figures describe a
12-document SQLite store on a small sandbox host and **do not** support any inference
about performance at corpus scale or under concurrency.

## 4. Method notes

- **Relevance is judged at document level.** Two chunks of the same document count as
  one hit, deduplicated while preserving the best rank, so a document that chunks into
  many pieces cannot inflate its own score.
- **A fresh store per run.** The database is deleted before and after, so no result
  can be inherited from a previous run's residue.
- **The corpus deliberately includes lexically distant queries.** A benchmark whose
  queries all echo their documents measures string matching and calls it retrieval.

## 5. Artefacts

| File | Contents |
|---|---|
| `benchmark-report.json` | Full machine-readable report, per-query outcomes, host spec, caveat block |
| `benchmarks/knowledge/corpus.json` | Corpus and relevance judgements |
| `scripts/benchmark-retrieval.ts` | Harness |
