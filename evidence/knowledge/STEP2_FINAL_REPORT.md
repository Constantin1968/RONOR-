# MIP-014 STEP 2 — Final Report

## R-Knowledge Plane Implementation, RONOR Sovereign Generative Intelligence Runtime

| Field | Value |
|---|---|
| **Instrument** | MIP-014-EO-STEP2 Rev 2 |
| **Validation** | MIP-014-EO-STEP2-VAL-001 — approved, signed, effective |
| **Executed by** | AMB, COO, Mayleven Ecosystem |
| **Repository** | `Constantin1968/RONOR-` |
| **Baseline commit** | `d058544d1c579611cce99cdf2b87a78d7534e75b` |
| **Baseline tree** | `629cd547b24c33118c039cab8c863b6a10cd8d59` |
| **Branch** | `mip-014/r-knowledge` |
| **Branch HEAD** | `aaeaaaa7f50e826fe3fb2c8f26b4ff30d650df55` |
| **Branch tree** | `bf7c24b57a3af9be2f39e74f75964f8faa0485a7` |
| **Commits** | 10, all local — **not pushed**; see § 9 |
| **Date** | 02 August 2026 |
| **Verdict** | **ALL TEN GATES PASS** — with three declared deviations and five stated limitations |

---

## 1. Executive summary

The R-Knowledge plane is implemented, verified and evidenced across ten phases and ten
gates, including the **absolute gate G5** which admits no waiver. The pre-existing test
corpus of 137 tests remains intact and passing in isolation; the whole suite stands at
**455 tests across 18 suites, all passing**. The governance and audit spine is
**byte-identical** to the baseline. **No dependency was added.**

Three matters deserve the reader's attention before the detail, because each involves a
judgement I made rather than a box I ticked.

**A real, silent defect was found and fixed at G4.** The ingestion pipeline computed its
duplicate-detection digest with a second, local implementation of the content-hash law
that omitted the canonicalisation step. Duplicate detection was therefore **completely
inert**: every re-admission of the same document would have created a fresh copy, with
no error and no warning. The corpus would have filled with duplicates and the first
visible symptom would have been degraded retrieval quality months later, with no
traceable cause.

**A second instance of the same failure shape was found at G8.** The activation
predicate `KNOWLEDGE_ENABLED === 'true'` existed **twice** — in `config.ts` and in the
plane factory. Both copies agreed exactly, so all 318 assertions passed and no
functional test could have detected anything. The hazard is prospective and severe: the
copy someone later relaxes to accept `'1'` need not be the copy the conformance suite
asserts against, so the suite would go on reporting that `'1'` is rejected while the
factory admitted it. Both defects share one cause — **a law stated twice** — and that
is the most transferable engineering finding of this work.

**Four defects were in my own verification instruments, and two would have produced a
false PASS on gates that cannot be waived.** These are catalogued in § 7 rather than
quietly corrected. A gate is only as strong as the instrument measuring it, and I would
rather report that I had to sharpen the instruments than present green results from
blunt ones.

---

## 2. Gate results

| Gate | Phase | Subject | Verdict |
|---|---|---|---|
| **G0** | 0 | Baseline verification and authorised branch | **PASS** |
| **G1** | 1 | Contract foundations — schema, config, invariants | **PASS** |
| **G2** | 2 | Deterministic core — chunker, embedder, provenance | **PASS** |
| **G3** | 3 | Store layer — conformance suite, degradation ladder | **PASS** |
| **G4** | 4 | Pipelines — ingestion, retrieval, RAG, injection guard | **PASS** |
| **G5** | 5 | **Disabled-mode baseline equivalence (ABSOLUTE)** | **PASS** |
| **G6** | 6 | Qdrant adapter against fully mocked transport | **PASS** |
| **G7** | 7 | Benchmark, conformance runner, CI, documentation | **PASS** |
| **G8** | 8 | Rollback drill and security review | **PASS** |
| **G9** | 9 | Final package and manifest | **PASS** |

### G0 — Baseline verification

All six zero-divergence conditions of STEP 1 § 3.2 satisfied: branch tip and tree equal
the canonical values, zero commits ahead or behind `main`, empty content divergence,
uncontaminated working tree. Baseline corpus confirmed at 8 suites / 137 tests.

### G1 — Contract foundations

Fourteen mandatory-field omissions each rejected with a field-specific error; unknown
top-level keys **rejected rather than stripped**; invariants K-INV-1 to K-INV-7
asserted. The activation predicate is tested against the full enumeration of rejected
values (`1`, `yes`, `TRUE`, `True`, `on`, `' true '`, empty, unset).

### G2 — Deterministic core

Chunking byte-stable across 100 runs; embeddings identical across 100 runs **and across
two separate OS processes**; dimension mismatch refused rather than coerced. Vectors
additionally asserted invariant under a host locale change to `tr_TR`, because Turkish
case-mapping would silently alter any embedder using `toLocaleLowerCase()`.

### G3 — Store layer

One shared conformance suite validates all three stores with **zero adapter-specific
branches**, verified by static scan and not merely by inspection. Production + SQLite
refuses with `SQLITE_PROHIBITED_IN_PRODUCTION` and the target directory is asserted
byte-identical before and after. All 16 pairwise degradation transitions reversible.

### G4 — Pipelines

Over-classified ingestion refused at stage I-3 with the stage trace proving hashing
(I-7) and embedding (I-9) were **never reached**. Twelve injection rules; quarantine
records hold a digest and have no payload field. RAG composition places retrieved
material inside a nonce-delimited region with instructions outside it, refuses below the
sufficiency threshold, and strips unresolvable citations rather than annotating them.

### G5 — Disabled-mode equivalence (absolute)

All nine prohibitions established by construction rather than assertion.

| # | Prohibition | Method |
|---|---|---|
| 1 | No route registered | All five routes 404 disabled; **all five respond when enabled** — the control |
| 2 | No plane in health | Eight planes in baseline order, static and runtime |
| 3–4 | No file or directory created | Whole-repository snapshot across 20 factory calls — **empty diff** |
| 5 | No timer | Handle count unchanged, plus static proof the class contains no timer call |
| 6 | No socket | `Socket` handle count unchanged |
| 7 | No credential read | A `Proxy` trap recorded **exactly one** read: `KNOWLEDGE_ENABLED`. A sentinel at `KNOWLEDGE_QDRANT_API_KEY` was never touched |
| 8 | No log beyond the gate decision | One `logger.debug` |
| 9 | No process handler | Listener counts unchanged in **both** modes |

Invariants BE-1 to BE-5 pass. `orchestrator.ts`, `audit/hash-chain.ts` and
`governance/mi9-gate.ts` proved byte-identical by **blob-hash comparison**, not keyword
search. `verify-chain` reports `ok: true`.

### G6 — Qdrant adapter

Eight conditions precedent each refuse with the correct reason code, and each refusal is
asserted alongside `factoryInvocations === 0` and `getTransportConstructionCount() === 0`
— no transport object came into existence, so no request could have been issued.
Neutrality N-1 to N-8, credential hygiene CH-1 to CH-5, and payload rules CT-5/CT-7 all
pass. MT-1 to MT-8 held throughout.

### G7 — Benchmark and conformance

**Release gate (contractual, no waiver): PASS.**

| Metric | Value | Threshold |
|---|---|---|
| Citation accuracy | **1.000** | = 1.000 |
| Provenance completeness | **1.000** | = 1.000 |

**Operational qualification: QUALIFIED — but the caveat is part of the finding.**

| Metric | Value | Threshold |
|---|---|---|
| Recall@8 | 1.000 | ≥ 0.60 |
| MRR | 0.865 | ≥ 0.50 |
| *Recall@1 (diagnostic)* | *0.800* | *no threshold* |
| *Corpus fraction at k=8* | *0.667* | *no threshold* |

I predicted at G2 that the deterministic embedder would fail these thresholds. **I was
wrong**, and the correction cuts both ways: Recall@8 over a 12-document corpus returns
two-thirds of the corpus, so the ≥ 0.60 threshold is close to vacuous at this scale. A
query need only avoid ranking the relevant document in the bottom third. Recall@1 cannot
be satisfied by breadth and is the discriminating number — **four queries in twenty
failed to place the correct document first**. The report carries a `qualificationCaveat`
block declaring the PASS **conditional on corpus scale**.

Where the embedder is weak, with the mechanism named: MRR by lexical overlap runs
0.938 (high) / 0.905 (medium) / **0.692 (low)**. Query Q08 — *"who pays when a wind farm
is told to switch off"* — ranks the correct document **eighth**, because the document
says "renewable generator" and "reduce output" and no lexical bridge exists.

Conformance runner: **13 of 13 determinative checks PASS.** It re-verifies rather than
re-reads, because an evidence file merely read back proves only that the file exists.

### G8 — Rollback and security

Sixteen checks, zero failures. Determinative steps 5, 6, 9 and 10 all pass: reverted
tree equals the canonical baseline tree with an empty content diff; **0 of 48 added
files survive reversal**; the pre-existing corpus passes on the reverted tree; the audit
chain verifies; the runtime boots reporting eight planes and no `knowledge` key.

The drill runs in a **scratch worktree before any merge**, so it cannot damage the
branch it is drilling, and a failure means the branch is simply not merged.

Security: zero dependency change, no egress by default, credential hygiene CH-1 to CH-5
pass, governance spine byte-identical.

### G9 — Final package

Full suite **455/455** across 18 suites. Baseline corpus in isolation **137/137**.
`tsc --noEmit` clean, build succeeds, `npm audit --audit-level=critical` exits 0. All 16
required evidence artefacts present. File manifest with SHA-256 digests for all 52 added
files.

---

## 3. Change manifest

| Measure | Value |
|---|---|
| Files added | **52** |
| Files modified | **7** |
| Files deleted | **0** |
| Lines inserted | 15,231 |
| Lines deleted | **1** |
| Production dependencies | 9 → **9** |
| Development dependencies | 15 → **15** |
| Lockfile entries | 558 → **558** (diff empty) |

### The seven modified files, and the single deleted line

| File | Nature of change |
|---|---|
| `src/types/index.ts` | `'r-knowledge'` added to the `PlaneId` union |
| `src/index.ts` | Fail-closed gate wired at the composition root |
| `.env.example` | Additive configuration block |
| `.gitignore` | Additive runtime-artefact entries |
| `.github/workflows/ci.yml` | Two jobs appended; three pre-existing jobs **structurally identical** to baseline, verified by YAML parse |
| `README.md` | Section inserted before License |
| `CHANGELOG.md` | Entry under Unreleased |

The **single deleted line** is `| 'r-sentinel';` in the `PlaneId` union, replaced by
`| 'r-sentinel'` followed by the new member — a syntactic consequence of extending a
union, not a removal of functionality.

### Commit sequence

| Commit | Gate | Subject |
|---|---|---|
| `a447a2e` | G1 | Contract foundations |
| `1729f83` | G2 | Deterministic core |
| `3b92037` | G3 | Store layer |
| `e9a08bd` | G4 | Pipelines |
| `6afd6f2` | G5 | Plane integration and disabled-mode equivalence (absolute) |
| `f68f4e7` | G6 | Qdrant adapter against mocked transport |
| `93114c5` | G7 | Benchmark, conformance runner, CI, documentation |
| `fd9009b` | G8 | Rollback drill, backup and verified deletion |
| `b9b92f1` | G8 | Security review, SBOM, CVE assessment |
| `aaeaaaa` | G9 | File manifest with content digests |

---

## 4. Test corpus

| Corpus | Suites | Tests | Result |
|---|---|---|---|
| Pre-existing, **in isolation** | 8 | **137** | all pass |
| R-Knowledge | 10 | 318 | all pass |
| **Whole suite** | **18** | **455** | **all pass** |

The isolated run is what discharges invariant BE-4. A combined figure of 455 could
conceal a pre-existing test quietly deleted while new tests raised the total, which is
why the conformance runner executes both and compares the isolated count against 137
explicitly.

---

## 5. Three declared deviations from the Execution Plan

**First — the Qdrant client was not installed.** The plan anticipated `dependencies`
moving 9 → 10 and the lockfile 558 → 561. I did not install
`@qdrant/js-client-rest@1.18.0`. The Order authorises adapter development **against a
fully mocked transport** and forbids contacting a live service; installing an HTTP
client that must never be permitted to open a socket adds supply-chain surface for no
verification benefit, since every G6 assertion is satisfied by the in-process double.
Requirement 9b demands an *assessment* — pins, digest, `undici ≥ 6.27.0` floor,
licences, CVE position — and an assessment is a document, not an installation. The
adapter is written against a substitutable transport seam so a future instrument can add
the client without touching adapter logic. **If you prefer the plan's stated diff
exactly, this is a one-line change plus a lockfile update.**

**Second — R-Knowledge is not added to the plane array or the orchestrator, even when
enabled.** Nothing in the inference pipeline consumes retrieval, so including it would
change invariant BE-3 for no functional gain. `GET /health` reports eight planes in both
modes; R-Knowledge reports under its own key, present only when enabled.

**Third — the GitHub token named in the mandate was empty.** The repository proved
publicly readable, so clone and baseline verification proceeded on an anonymous read.
Push authority is absent; see § 9.

---

## 6. Five limitations that must not be read as cleared

**1. The Qdrant path is not a drop-in equal of the SQLite path.** Its payload excludes
`content` by design under rule CT-5, so `getById` and `getByHash` return `null` and
**content retrieval is unsupported**. Vector search and duplicate detection work;
reconstituting a Knowledge Object does not. A deployment requiring content retrieval
needs a content store inside the sovereignty boundary.

**2. The CVE position is a documentary assessment, not a live query.** It records the
dossier's pinned version, digest, `undici` floor and licence findings. **I did not query
a vulnerability database on the date of this review.** Nothing here certifies that no
advisory has been published since. A fresh query is required before any instrument
authorises installing the client.

**3. Pattern screening is bounded, and the boundary is in the test suite.** Rule IG-01
does **not** catch inter-character spacing evasion (`I g n o r e   a l l …`) because
whitespace collapse does not remove spacing between individual characters. A test
asserts this gap. Structural separation — the nonce-delimited data region — is the
primary control; screening is secondary.

**4. The benchmark's operational qualification is conditional on corpus scale.** See
§ 2 (G7). Recall@8 over twelve documents is a weak measure. Re-measure on a corpus an
order of magnitude larger before relying on it for an operational decision.

**5. SQLite is prohibited in production, and the prohibition is load-bearing.** A
production deployment has **no authorised store** until one is provisioned under a
future instrument, and will sit at degradation level 3. That is the intended posture,
not a gap to work around.

---

## 7. Defects found — in the implementation and in my own instruments

### In the implementation (two, both real, both from one cause)

| Gate | Defect | Consequence had it shipped |
|---|---|---|
| G4 | Ingestion computed its duplicate-detection digest with a second, local hash implementation omitting `canonicalStringify` | Duplicate detection **silently inert**. Every re-admission creates a fresh copy, no error raised, corpus fills with duplicates, first symptom is degraded quality months later with no traceable cause |
| G8 | The activation predicate existed **twice**, in `config.ts` and in the plane factory | Prospective. The copy someone later relaxes to accept `'1'` need not be the copy the suite asserts against — the suite would report `'1'` rejected while the factory admitted it |

Both have one cause: **a law stated twice.** Each is now stated once and imported. This
is the strongest practical argument for that discipline in the entire exercise — the
first bug existed for exactly as long as there were two implementations of one law.

### In my own verification instruments (four, disclosed rather than corrected quietly)

| Gate | Instrument defect | Why it mattered |
|---|---|---|
| G5 | Route probe used POST for every route | GET routes returned 404 **even when mounted**. The disabled-mode claim would have passed on a broken probe — **a false PASS on the absolute gate** |
| G5 | Control check used `any(code != 404)` where `all` was required | Would have passed while some routes were silently unmounted — **a second false-PASS path on the absolute gate** |
| G7 | Citation check compared against the bare label, not the bracketed grammar | Scored **0.000** on a no-waiver release gate. The obvious response to a failing contractual metric is to change the code; had I done so I would have altered a **correct** implementation to satisfy a broken ruler, and the resulting 1.000 would have been a fabrication |
| G8 | Drill counted its own uncommitted files as contamination | A drill that refuses to run unless everything is already committed cannot be used when it is most needed |

One assertion I wrote was **impossible for any correct implementation to satisfy** — it
demanded that `createKnowledgeRouter` be absent from unguarded code, which no ES module
can achieve because imports are hoisted. That was a broken test, not a detected defect,
and I narrowed it to the invocation and pinned it to exactly one call site.

Three test expectations were also corrected **against observed behaviour rather than by
bending the code**. The most consequential: I expected an embedding-degraded object to
carry an empty `vectorHash`. It must not — an empty hash fails the 64-hex-character
requirement, so such an object could not be stored and the document would be **lost**
rather than preserved for re-embedding. The correct sentinel is the digest of the empty
vector. I did not relax the schema to accommodate my expectation.

---

## 8. Evidence artefacts

All under `evidence/knowledge/` on the branch.

| Artefact | Contents |
|---|---|
| `branch-attestation.txt` | G0 six-condition verification |
| `G5-equivalence-attestation.md` | The absolute gate, nine prohibitions and five invariants |
| `equivalence-report.json` | Machine-readable equivalence verdict |
| `health-disabled.json` / `health-enabled.json` | Runtime health payloads, both modes |
| `routes-disabled.txt` / `routes-enabled.txt` | Route probes with correct HTTP verbs |
| `fs-diff-disabled.txt` | Empty — the filesystem claim |
| `qdrant-adapter-report.md` | Eight conditions precedent, neutrality, credential hygiene |
| `qdrant-dependency-assessment.md` | Requirement 9b: pins, digest, licences, CVE position |
| `mocked-transport-attestation.txt` | MT-1 to MT-8 negative attestation |
| `benchmark-report.json` / `.md` | Metrics, per-query outcomes, host spec, caveat block |
| `conformance-report.json` | 14 checks, 13 determinative |
| `rollback-report.md` | Thirteen steps, the predicate defect, instrument defects |
| `security-review.md` | Dependency surface, egress, credentials, isolation, limitations |
| `sbom.json` | 547 resolved components |
| `file-manifest.txt` | SHA-256 digests for all 52 added files |

---

## 9. Disclosed limitation — the work is not pushed

**All ten commits exist locally only.** The `GITHUB_TOKEN` named in the mandate was
empty, `gh auth status` reports no authenticated host, and `git push` fails with
`could not read Username for 'https://github.com'`. I attempted to enable the GitHub
connector to obtain write credentials; **the request was declined at your end**, which
is a legitimate outcome and not an error.

I have therefore produced a **verifiable portable bundle** so the work is not trapped in
this sandbox:

```
/home/ubuntu/mip-014-r-knowledge.bundle   (208 KB)
```

It verifies against the canonical baseline and contains exactly one ref:

```
aaeaaaa7f50e826fe3fb2c8f26b4ff30d650df55  refs/heads/mip-014/r-knowledge
requires: d058544d1c579611cce99cdf2b87a78d7534e75b
```

To apply it in any clone of the repository:

```bash
git clone https://github.com/Constantin1968/RONOR-.git && cd RONOR-
git fetch /path/to/mip-014-r-knowledge.bundle mip-014/r-knowledge:mip-014/r-knowledge
git checkout mip-014/r-knowledge
npm ci && npm test          # expect 18 suites, 455 tests
```

**Consequences to note.** CI has **not** executed on GitHub Actions; the three
pre-existing jobs and two added jobs are verified locally and by YAML structural
comparison, but no GitHub run exists. No pull request has been opened. Nothing has been
merged to `main`, which remains at `d058544d`.

To complete delivery, provide a token with `repo` write scope, or apply the bundle from
a machine that already holds push authority. **No re-verification is required after
push** — the commits are immutable and every gate result is recorded in them.

---

## 10. Next decision recommended

The plane is complete as **authorised**, and the authorisation deliberately stopped
short of production retrieval. Three decisions now stand before that becomes possible,
and I recommend taking them in this order.

**First, and cheapest: push and let CI run.** Everything else is speculative until the
two additive jobs execute on GitHub's runners rather than mine. This costs a token.

**Second: decide the embedding provider, because it is the binding constraint.** The
deterministic adapter is fit for reproducible infrastructure verification and unfit for
users who phrase queries in their own words — MRR 0.692 on lexically distant queries is
the measured evidence. A learned embedding is the only route to production retrieval,
and it brings a governance question the present work carefully avoided: an embedding
model is an external dependency whose behaviour must itself be governed, and whose use
implies egress. **This is a policy decision, not an engineering one, and it should not
be taken by an implementer.**

**Third, and only then: the store.** SQLite is prohibited in production and no
authorised production store exists, so a production deployment today sits at degradation
level 3 by design. Qdrant is adapter-ready but cannot serve content retrieval; if the
architecture needs objects reconstituted from the store, a content store inside the
sovereignty boundary is required alongside it. That combination should be specified
before provisioning, not after.

I would **not** recommend enabling R-Knowledge in production on the strength of this
work. It is release-qualified as **experimental infrastructure**, which is what STEP 1
§ 17.6 contemplates, and the honest position is that it is exactly that: correct,
evidenced, reversible, and not yet a retrieval system anyone should rely on.

---

*Prepared by AMB, COO, Mayleven Ecosystem, under MIP-014-EO-STEP2-VAL-001.*
*Report reflects branch state `aaeaaaa7f50e826fe3fb2c8f26b4ff30d650df55` as at 02 August 2026.*
