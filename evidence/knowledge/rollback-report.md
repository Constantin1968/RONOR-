# Rollback Drill Report

**Gate:** G8
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Procedure:** STEP 1 § 19 — thirteen steps, executed **before** any merge
**Branch:** `mip-014/r-knowledge`
**Baseline:** `d058544d1c579611cce99cdf2b87a78d7534e75b`
**Date:** 02 August 2026
**Verdict:** **PASS**

## 1. Why this drill is run before merge, not after

A rollback procedure verified after a merge is a procedure verified at the one moment
it is least needed. The drill is run **on the branch, before integration**, so that if
the procedure does not work the branch is simply not merged — which is a decision, not
an incident.

Per the Execution Plan, **steps 5, 6, 9 and 10 are jointly determinative** of the
gate. Commit identity is expressly **not** an acceptance criterion: reverting a branch
produces new commit objects by construction, and demanding identical hashes would be
demanding something git cannot provide.

## 2. The thirteen steps

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Confirm the authority under which rollback is performed | PASS | MIP-014-EO-STEP2-VAL-001; rollback is pre-authorised as a reversal of a branch not yet merged |
| 2 | Record the pre-rollback state | PASS | HEAD `93114c5`, 7 commits ahead of baseline |
| 3 | Confirm the feature flag is the primary control | PASS | Exactly **one** executable definition of the activation predicate. This step found a real defect — see § 6 |
| 4 | Confirm no destructive migration was applied | PASS | No schema migration exists. The SQLite store creates its own tables on `open()` in a file outside the repository; the audit chain schema is untouched |
| 5 | **Revert the branch and verify tree identity to baseline** | **PASS** | See § 3. Executed in a scratch worktree, so the drill cannot damage the branch it is drilling |
| 6 | **Verify the pre-existing test corpus passes on the reverted tree** | **PASS** | 8 suites, 137/137 |
| 7 | Confirm no external state requires reversal | PASS | Discharged by written confirmation — see § 4 |
| 8 | Confirm no credential requires rotation | PASS | No credential was ever transmitted. The only credential-shaped value used in tests is the literal `test-key-not-a-real-credential` |
| 9 | **Verify the audit chain still verifies after reversal** | **PASS** | `verify-chain` reports `ok: true` |
| 10 | **Verify the runtime boots and serves on the reverted tree** | **PASS** | `/health` 200, eight planes, baseline route set |
| 11 | Record what would be lost by reversal | PASS | See § 5 |
| 12 | Confirm reversal is idempotent | PASS | Re-running the revert on an already-reverted tree is a no-op producing an empty diff |
| 13 | Restore the working branch and confirm no residue | PASS | Branch restored to `93114c5`; tree diff against pre-drill state empty |

## 3. Step 5 — tree identity after reversal (determinative)

The reversal method is `git checkout` of the baseline tree into a scratch worktree,
because what matters is **tree identity**, not commit lineage.

| Measure | Value |
|---|---|
| Baseline tree | `629cd547b24c33118c039cab8c863b6a10cd8d59` |
| Reverted tree | `629cd547b24c33118c039cab8c863b6a10cd8d59` |
| Content diff against baseline | **empty** |
| Files removed by reversal | 26 added by this work |
| Files restored to baseline content | 6 modified by this work |

Every file this work touched is either removed or restored. Nothing added by MIP-014
survives reversal, and nothing pre-existing is left altered.

## 4. Step 7 — external state, discharged by written confirmation

Step 7 asks whether external state must be reversed. It is discharged by the following
written confirmation, which is the form the Execution Plan specifies:

> **No Qdrant service was configured, provisioned, started, contacted, written to or
> operated at any point during MIP-014 STEP 2 implementation.** No external vector
> store holds any object originating from this work. No collection was created, no
> point was written, and no endpoint was resolved.

Consequently the destructive-reversal procedures **D-1 to D-5** (collection deletion,
point purge, credential rotation, endpoint decommission, deployment-record annotation)
are **NOT ENGAGED**. There is no external state to reverse because none was ever
created.

Corroboration is structural rather than testimonial: no Qdrant client is installed, no
container manifest declares such a service, the `docker` binary is absent from the
environment, and every refusal path is asserted to have constructed zero transports.
See `mocked-transport-attestation.txt`.

## 5. Step 11 — what reversal would cost

Reversal is complete and safe, but it is not free. Recorded so that the decision to
revert is taken with the cost visible:

| Lost | Detail |
|---|---|
| Implementation | 18 source modules, ~6,400 lines |
| Verification | 10 test suites, 318 assertions |
| Evidence | 15 artefacts under `evidence/knowledge/` |
| Benchmark | Corpus, harness and recorded baseline metrics |
| CI | Two additive jobs |

**Not lost by reversal:** nothing in the pre-existing runtime, because nothing in it
was modified. That is the point of the additive discipline, and it is why reversal is a
cheap decision rather than a risky operation.

## 6. A real defect the drill found, which no functional test would have caught

Step 3 asks whether the feature flag is genuinely the primary control. I implemented
it as a count of **executable definitions** of the activation predicate, expecting one.
It found **two**: `config.ts` defined `isKnowledgeEnabled`, and
`planes/r-knowledge/index.ts` defined a second copy of the same function.

Both copies read `env.KNOWLEDGE_ENABLED === 'true'`. They agreed exactly, so every one
of the 318 assertions passed, the G5 absolute gate passed, and no functional test could
have detected anything wrong — because on the day it was written, nothing was.

The hazard is entirely prospective, and it is severe. Two copies of a
security-relevant predicate drift silently, because **the copy someone later relaxes to
accept `'1'` is not necessarily the copy the conformance suite asserts against.** The
suite would continue to report that `'1'` is rejected while the factory admitted it.
That is the exact shape of the ingestion duplicate-detection defect found at G4, where
two implementations of one hashing law silently disagreed — and it is the second time
in this implementation that duplication of a stated law produced, or was about to
produce, a real fault.

The fix removes the duplicate: `index.ts` now re-exports the single definition from
`config.ts`. The check remains in the drill in its strengthened form.

### Two defects in the drill's own instruments, disclosed

The first run reported three failures, and only one of them was a real finding.

| Reported failure | Diagnosis |
|---|---|
| Predicate defined in 3 modules | **Partly real.** The count included two documentation comments *and* one genuine duplicate implementation. The filter now excludes comments; the duplicate was removed. |
| Working tree not clean (2 files) | **Instrument defect.** The drill counted its own uncommitted script and report as contamination. A drill that refuses to run unless everything is already committed cannot be used at the moment it is most needed. It now records the pre-state and verifies at step 13 that it leaves the tree as it found it. |
| Residue left in working tree | **Instrument defect.** Same cause: compared against zero rather than against the pre-drill count. |

The pattern is worth naming, because it has now recurred at G5, G6, G7 and G8: **a
gate is only as strong as the instrument measuring it.** Three of the four
measurement defects I have found in this implementation were in my own verification
code, not in the implementation under test, and two of them would have produced a
false PASS.

## 7. The property that makes rollback almost unnecessary

The feature flag is the primary control and the revert is the secondary one. Because
`KNOWLEDGE_ENABLED` unset yields a runtime observationally indistinguishable from
baseline — proved at G5 across nine prohibitions and five invariants — an operator
facing a problem in production can return to baseline behaviour by **removing one
environment variable**, with no deployment, no revert and no downtime.

A code revert is therefore the second line of defence, not the first. Both were
verified; only one is likely ever to be needed.
