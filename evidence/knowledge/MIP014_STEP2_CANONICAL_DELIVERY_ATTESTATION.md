# MIP-014 STEP 2 — Canonical Delivery Attestation

**Instrument:** MIP-014-EO-STEP2 Rev 2
**Validation:** MIP-014-EO-STEP2-VAL-001 — approved, signed, effective
**Attested by:** AMB, COO, Mayleven Ecosystem
**Date:** 02 August 2026, 12:09 UTC

---

## 1. Identity of the delivered work

| Field | Value |
|---|---|
| Repository | `Constantin1968/RONOR-` |
| Branch | `mip-014/r-knowledge` |
| **Branch HEAD** | `06cb74b8c367d7dcab1fd57b02358346742adf1a` |
| Branch tree | `54135d22a3373ed4a42d11d6e24721a883a91e7e` |
| Canonical baseline commit | `d058544d1c579611cce99cdf2b87a78d7534e75b` |
| Canonical baseline tree | `629cd547b24c33118c039cab8c863b6a10cd8d59` |
| Commits ahead of baseline | **12** |
| Push status | **Not pushed — all commits are local** (see § 7) |

---

## 2. Commit sequence

| Commit | Gate | Subject |
|---|---|---|
| `a447a2e` | G1 | R-Knowledge contract foundations |
| `1729f83` | G2 | R-Knowledge deterministic core |
| `3b92037` | G3 | R-Knowledge store layer |
| `e9a08bd` | G4 | R-Knowledge pipelines |
| `6afd6f2` | **G5** | **Plane integration and disabled-mode equivalence (ABSOLUTE gate)** |
| `f68f4e7` | G6 | Qdrant adapter verification against a fully mocked transport |
| `93114c5` | G7 | Benchmark, conformance runner, additive CI and documentation |
| `fd9009b` | G8 | Rollback drill, backup and verified deletion |
| `b9b92f1` | G8 | Security review, SBOM and CVE assessment |
| `aaeaaaa` | G9 | File manifest with content digests |
| `57f6420` | G9 | STEP 2 Final Report |
| `06cb74b` | G9 | Final report HEAD references corrected |

---

## 3. Verification results at HEAD

All results were obtained by executing the tools, not by reading prior outputs.

### 3.1 Test corpus

| Corpus | Suites | Tests | Result |
|---|---|---|---|
| Pre-existing, **in isolation** | 8 | **137** | **all pass** |
| R-Knowledge | 10 | 318 | all pass |
| **Whole suite** | **18** | **455** | **all pass** |

The isolated run is the operative claim for invariant BE-4. A combined total of 455 could
conceal a pre-existing test quietly deleted while new tests raised the figure; the
conformance runner executes both and compares the isolated count against 137 explicitly.

### 3.2 Build and security

| Check | Command | Result |
|---|---|---|
| TypeScript strict-mode typecheck | `npx tsc --noEmit` | **PASS** |
| Production build | `npm run build` | **PASS** |
| Critical CVE audit | `npm audit --audit-level=critical` | **exit 0** |

### 3.3 Governance and audit spine — byte-identical to baseline

The three files that constitute the governance and integrity root are verified by
comparing their git blob hashes at the baseline commit and at HEAD. A matching blob hash
means the file content is **bit-for-bit identical** — not merely similar, not
semantically equivalent.

| File | Baseline blob | HEAD blob | Identical |
|---|---|---|---|
| `src/orchestrator.ts` | `903f2f8a` | `903f2f8a` | **YES** |
| `src/audit/hash-chain.ts` | `fe5d39fd` | `fe5d39fd` | **YES** |
| `src/governance/mi9-gate.ts` | `12810f37` | `12810f37` | **YES** |

`verify-chain` on the HEAD tree: `"ok": true`.

### 3.4 Dependency surface — unchanged

| Measure | Baseline | HEAD | Change |
|---|---|---|---|
| Production dependencies | 9 | **9** | none |
| Development dependencies | 15 | **15** | none |
| `package.json` dependency diff | — | **empty** | none |
| `package-lock.json` diff | — | **empty** | none |

No package was added, removed, upgraded or downgraded. The entire plane is built from
packages already present in the baseline. This is the single most consequential security
property of the work: no new dependency means no new transitive attack surface and no
new supply-chain trust decision.

---

## 4. Change surface

| Measure | Value |
|---|---|
| Files added | **54** |
| Files modified | **7** |
| Files deleted | **0** |
| Lines inserted | 15,231 |
| Lines deleted | 1 |

### Modified files

| File | Nature of change |
|---|---|
| `src/types/index.ts` | `'r-knowledge'` added to the `PlaneId` union; **1 line deleted** (syntactic consequence of extending a union, not a removal) |
| `src/index.ts` | Fail-closed gate wired at the composition root |
| `.env.example` | Additive configuration block |
| `.gitignore` | Additive runtime-artefact entries |
| `.github/workflows/ci.yml` | Two jobs appended; three pre-existing jobs structurally identical to baseline, verified by YAML parse |
| `README.md` | Section inserted before License heading |
| `CHANGELOG.md` | Entry under Unreleased |

---

## 5. Gate verdicts

| Gate | Subject | Verdict |
|---|---|---|
| G0 | Baseline verification and authorised branch creation | **PASS** |
| G1 | Contract foundations — schema, config, K-INV invariants | **PASS** |
| G2 | Deterministic core — chunker, embedder, provenance | **PASS** |
| G3 | Store layer — shared conformance suite, degradation ladder | **PASS** |
| G4 | Pipelines — ingestion, retrieval, RAG, injection guard | **PASS** |
| **G5** | **Disabled-mode baseline equivalence (ABSOLUTE — no waiver)** | **PASS** |
| G6 | Qdrant adapter against fully mocked in-process transport | **PASS** |
| G7 | Benchmark, conformance runner, additive CI, documentation | **PASS** |
| G8 | Rollback drill (16 checks) and security review | **PASS** |
| G9 | Final package, manifest, attestation | **PASS** |

### G5 detail — the gate that cannot be waived

Nine disabled-mode prohibitions, all established by construction rather than assertion:

| # | Prohibition | Verification method |
|---|---|---|
| 1 | No route registered | All five routes return 404 when disabled; all five respond when enabled (the control) |
| 2 | No plane in health | Eight planes in baseline order, static and runtime |
| 3–4 | No file or directory created | Whole-repository snapshot across 20 factory calls — **empty diff** |
| 5 | No timer | Handle count unchanged; static proof the class contains no timer call |
| 6 | No socket | `Socket` handle count unchanged |
| 7 | No credential read | A `Proxy` trap recorded **exactly one** property read: `KNOWLEDGE_ENABLED`. A sentinel at `KNOWLEDGE_QDRANT_API_KEY` was never touched |
| 8 | No log beyond the gate decision | One `logger.debug` |
| 9 | No process handler | Listener counts unchanged in both modes |

### G7 benchmark detail

**Release gate (contractual, no waiver):**

| Metric | Value | Threshold | Result |
|---|---|---|---|
| Citation accuracy | **1.000** | = 1.000 | PASS |
| Provenance completeness | **1.000** | = 1.000 | PASS |

**Operational qualification — PASS, conditional on corpus scale:**

| Metric | Value | Threshold |
|---|---|---|
| Recall@8 | 1.000 | ≥ 0.60 |
| MRR | 0.865 | ≥ 0.50 |
| Recall@1 (diagnostic) | 0.800 | no threshold |

The `qualificationCaveat` block in `benchmark-report.json` records that Recall@8 over
twelve documents is a weak measure. Recall@1 is the discriminating number. Four queries
in twenty failed to place the correct document first. Re-measure on a corpus an order of
magnitude larger before relying on this for an operational decision.

### G8 rollback drill detail

The drill executed the thirteen-step reversal procedure in a **scratch worktree** before
any merge. Determinative steps 5, 6, 9 and 10 all pass:

- Step 5: reverted tree equals `629cd547` canonical baseline tree; content diff empty; **0 of 54 files added by this work survive reversal**
- Step 6: pre-existing corpus on the reverted tree — 8 suites, **137/137**
- Step 9: `verify-chain` on the reverted tree — `ok: true`
- Step 10: runtime boots, `/health` 200, **eight planes**, no `knowledge` key

The drill found **one real defect**: the activation predicate `KNOWLEDGE_ENABLED === 'true'` existed in two modules. Both agreed exactly, so all 318 assertions passed and no functional test could have detected anything — the hazard is prospective. The copy someone later relaxes need not be the copy the conformance suite asserts against. Fixed by removing the duplicate and re-exporting the single definition.

---

## 6. Evidence artefacts

All 19 artefacts reside under `evidence/knowledge/` on the branch.

| Artefact | Gate | Contents |
|---|---|---|
| `branch-attestation.txt` | G0 | Six-condition baseline verification |
| `G5-equivalence-attestation.md` | G5 | Nine prohibitions, five invariants, runtime probes |
| `equivalence-report.json` | G5 | Machine-readable equivalence verdict |
| `health-disabled.json` | G5 | Runtime health payload, disabled mode |
| `health-enabled.json` | G5 | Runtime health payload, enabled mode |
| `routes-disabled.txt` | G5 | Route probe results, disabled mode |
| `routes-enabled.txt` | G5 | Route probe results, enabled mode |
| `fs-diff-disabled.txt` | G5 | Filesystem diff — empty |
| `qdrant-adapter-report.md` | G6 | Eight conditions precedent, neutrality, credential hygiene |
| `qdrant-dependency-assessment.md` | G6 | Requirement 9b: pins, digest, licences, CVE position |
| `mocked-transport-attestation.txt` | G6 | MT-1 to MT-8 negative attestation |
| `benchmark-report.json` | G7 | Metrics, per-query outcomes, host spec, caveat block |
| `benchmark-report.md` | G7 | Narrative benchmark report |
| `conformance-report.json` | G7 | 14 checks, 13 determinative |
| `rollback-report.md` | G8 | Thirteen steps, real defect found, instrument defects |
| `security-review.md` | G8 | Dependency surface, egress, credentials, isolation, limitations |
| `sbom.json` | G8 | 547 resolved components |
| `file-manifest.txt` | G9 | SHA-256 digests for all 54 added files |
| `STEP2_FINAL_REPORT.md` | G9 | The complete STEP 2 Final Report |

---

## 7. Portable bundle — the delivery vehicle

Because the branch has not been pushed to GitHub (no write token is available in this
environment), the work is delivered as a **verified git bundle**.

| Property | Value |
|---|---|
| File | `mip-014-r-knowledge.bundle` |
| Size | 219 KB |
| SHA-256 | `ef4e6f03508ce1d1046576021000f26f0befe4661ea442efeca559fcec200dfa` |
| Contains | `06cb74b8c367d7dcab1fd57b02358346742adf1a refs/heads/mip-014/r-knowledge` |
| Requires | `d058544d1c579611cce99cdf2b87a78d7534e75b` (the canonical baseline) |
| Verification | `git bundle verify` — **ok** |

### To apply the bundle

```bash
# In any existing clone of Constantin1968/RONOR-
git fetch /path/to/mip-014-r-knowledge.bundle \
    mip-014/r-knowledge:mip-014/r-knowledge
git checkout mip-014/r-knowledge
npm ci && npm test          # expect 18 suites, 455 tests
```

### To push once a write token is available

```bash
# In the same clone, after applying the bundle
git push origin mip-014/r-knowledge
```

No re-verification is required after push. The commits are immutable; every gate result
is recorded in them. CI will execute on GitHub Actions for the first time at that point.

---

## 8. Three declared deviations from the Execution Plan

**1. The Qdrant client was not installed.** The plan anticipated `dependencies` 9 → 10
and lockfile 558 → 561. The Order authorises adapter development against a fully mocked
transport and forbids contacting a live service. Installing an HTTP client that must
never be permitted to open a socket adds supply-chain surface for no verification
benefit. The adapter is written against a substitutable transport seam; a future
instrument can add the client without touching adapter logic.

**2. R-Knowledge is not added to the plane array or the orchestrator, even when
enabled.** Nothing in the inference pipeline consumes retrieval, so inclusion would
change invariant BE-3 for no functional gain. `GET /health` reports eight planes in both
modes; R-Knowledge reports under its own key, present only when enabled.

**3. The GitHub token named in the mandate was empty.** The repository is publicly
readable, so clone and baseline verification proceeded anonymously. Push authority is
absent; the bundle is the delivery vehicle.

---

## 9. Five limitations that must not be read as cleared

**1. The Qdrant path does not support content retrieval.** Its payload excludes `content`
by design under rule CT-5. `getById` and `getByHash` return `null`. Vector search and
duplicate detection work; reconstituting a Knowledge Object does not.

**2. The CVE position is a documentary assessment, not a live query.** A fresh query is
required before any instrument authorises installing the Qdrant client.

**3. Pattern screening is bounded.** Rule IG-01 does not catch inter-character spacing
evasion. A test asserts this gap. Structural separation — the nonce-delimited data region
— is the primary control.

**4. The benchmark's operational qualification is conditional on corpus scale.** Recall@8
over twelve documents is a weak measure. Re-measure on a corpus an order of magnitude
larger before relying on it for an operational decision.

**5. SQLite is prohibited in production.** A production deployment has no authorised
store until one is provisioned under a future instrument, and will sit at degradation
level 3 by design.

---

## 10. Recommended next decision

In order of dependency:

1. **Push the bundle** — provide a token with `repo` write scope, apply the bundle from
   a machine with push authority, and let CI run. Everything else is speculative until
   the two additive CI jobs execute on GitHub's runners.

2. **Decide the embedding provider** — this is a **policy decision**, not an engineering
   one. A learned embedding implies egress and its own governance. The deterministic
   adapter is fit for infrastructure verification and unfit for users who phrase queries
   in their own words (MRR 0.692 on lexically distant queries is the measured evidence).

3. **Provision the production store** — only after the embedding provider is decided,
   because the store choice depends on whether content retrieval is required alongside
   vector search.

**This work does not authorise enabling R-Knowledge in production.** It is
release-qualified as experimental infrastructure, which is what STEP 1 § 17.6
contemplates, and the honest position is that it is exactly that: correct, evidenced,
reversible, and not yet a retrieval system anyone should rely on.

---

*Attested by AMB, COO, Mayleven Ecosystem, under MIP-014-EO-STEP2-VAL-001.*
*Branch HEAD `06cb74b8c367d7dcab1fd57b02358346742adf1a` as at 02 August 2026, 12:09 UTC.*
