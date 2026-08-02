# Gate G5 Attestation — Disabled-Mode Baseline Equivalence

**Gate:** G5 (ABSOLUTE — not waivable)
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Baseline commit:** `d058544d1c579611cce99cdf2b87a78d7534e75b`
**Baseline tree:** `629cd547b24c33118c039cab8c863b6a10cd8d59`
**Branch:** `mip-014/r-knowledge`
**Verdict:** **PASS**

## The claim

With `KNOWLEDGE_ENABLED` absent or not exactly the string `"true"`, the RONOR
runtime is observationally indistinguishable from the baseline commit.

## The mechanism

`RKnowledgePlane.create()` evaluates the activation predicate **before** `new`,
before configuration is resolved, and before any module with a side effect is
touched. When the predicate is false the factory returns `null` and **no plane
instance comes into existence**. The class constructor is `private`, so the gate
cannot be bypassed by a caller who instantiates the class directly.

A conditional placed *inside* a constructed object would satisfy none of the nine
prohibitions, because construction is itself an observable event: it allocates, it
may resolve a path, it may open a handle, and it appears in a plane roster. The
gate is therefore in a factory rather than in a constructor.

## The nine disabled-mode prohibitions (STEP 1 § 4.2)

| # | Prohibition | How it is established | Result |
|---|---|---|---|
| 1 | No route registered | Runtime probe: all five knowledge routes return **404** in disabled mode, and all five respond (400/200/403/200/200) when enabled — the control proves the probe can detect a mount | PASS |
| 2 | No plane in health | `GET /health` reports exactly the eight baseline planes in baseline order; static analysis confirms `knowledge` is absent from the `planes` array literal and from the orchestrator constructor | PASS |
| 3 | No database file created | Whole-repository filesystem snapshot before and after 20 factory calls across 10 disabled variants: **empty diff** | PASS |
| 4 | No directory created | Same snapshot, same empty diff | PASS |
| 5 | No timer scheduled | Live handle count unchanged; and static assertion that the plane class contains **no** `setInterval`/`setTimeout`/`setImmediate` in executable code, so the property holds in enabled mode too | PASS |
| 6 | No network connection | Live `Socket` handle count unchanged | PASS |
| 7 | No credential read | A `Proxy` trap over the environment records every property **read**. Exactly one property was read: `KNOWLEDGE_ENABLED`. A sentinel value planted at `KNOWLEDGE_QDRANT_API_KEY` was never touched | PASS |
| 8 | No log line beyond the gate decision | A single `logger.debug` recording the decision; it reads no credential, resolves no path and touches no store configuration | PASS |
| 9 | No process handler installed | Listener counts for `SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection` unchanged — asserted in **both** disabled and enabled-and-initialised modes | PASS |

## The five baseline-equivalence invariants (STEP 1 § 4.1)

| Invariant | Requirement | Observed | Result |
|---|---|---|---|
| BE-1 | Route set identical to baseline | All knowledge routes 404; all baseline routes 200 | PASS |
| BE-2 | Baseline routes unaffected | `/health`, `/api/v1/sentinel/status`, `/api/v1/model-exchange/registry` all 200 | PASS |
| BE-3 | Exactly eight planes, in order | `r-gateway, r-context, r-model-fabric, r-agent-runtime, r-execution, r-assurance, r-economics, r-sentinel` | PASS |
| BE-4 | Pre-existing tests unchanged | 8 suites, **137/137** passing | PASS |
| BE-5 | Empty filesystem diff | 0 diff lines | PASS |

### Health payload comparison

| | Top-level keys |
|---|---|
| Disabled | `models, planes, sentinel, status, uptime, version` |
| Enabled | `knowledge, models, planes, sentinel, status, uptime, version` |

The `knowledge` key is **absent** in disabled mode rather than present-and-null. A
null field would still be a structural diff in the response body; an absent key is
not. This is achieved with a conditional spread rather than a nullable field.

Note also **BE-3c**: the eight-plane roster is unchanged even when R-Knowledge is
*enabled*. The plane is deliberately not added to the `planes` array and not passed
to the orchestrator, because nothing in the inference pipeline consumes retrieval.
Adding it would change a baseline-equivalence invariant for no functional gain.

## Isolation from the governance and audit spine (STEP 1 § 13.2)

Eighteen knowledge modules were each asserted, over **executable code with comments
stripped**, to import nothing from `src/audit/hash-chain`, `src/governance/mi9-gate`
or `src/orchestrator`, and to reference neither `AuditHashChain` nor `verifyChain`.
Comment stripping matters in both directions: without it, a prohibition could be
"satisfied" by a comment mentioning the forbidden construct, or falsely failed by
prose describing what the code deliberately avoids.

Byte-identity to the baseline was verified by **blob hash comparison** rather than
by keyword search:

| Path | Baseline blob | Current blob | Identical |
|---|---|---|---|
| `src/orchestrator.ts` | see `equivalence-report.json` | same | yes |
| `src/audit/hash-chain.ts` | see `equivalence-report.json` | same | yes |
| `src/governance/mi9-gate.ts` | see `equivalence-report.json` | same | yes |

`npm run verify-chain` reports `ok: true`.

## Recorded limitation of the harness

Runtime boot uses `node dist/index.js`, the documented start path. `ts-node
src/index.ts` does **not** boot at the baseline commit either: `src/api/model-exchange-router.ts`
imports `"../model-exchange/registry.js"` with an explicit `.js` extension, which
CommonJS `ts-node` cannot resolve. This is a **pre-existing condition of the
baseline**, unrelated to MIP-014, and is recorded here rather than repaired, since
repairing it would be a change outside the authority of this Order.

## Evidence artefacts

| File | Contents |
|---|---|
| `equivalence-report.json` | Machine-readable verdict, all ten checks, blob hashes |
| `health-disabled.json` | `GET /health` payload, disabled mode |
| `health-enabled.json` | `GET /health` payload, enabled mode |
| `routes-disabled.txt` | Route probe results, disabled mode |
| `routes-enabled.txt` | Route probe results, enabled mode |
| `fs-diff-disabled.txt` | Filesystem diff (empty) |
| `../../tests/knowledge/equivalence.test.ts` | 42 automated assertions |

## Reproduction

```bash
npm run build
bash scripts/knowledge-equivalence.sh     # runtime harness, both modes
npx jest tests/knowledge/equivalence.test.ts   # 42 static and handle assertions
```
