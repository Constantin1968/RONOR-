# Security Review and Dependency Assessment

**Gate:** G8 (security limb)
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Scope:** the R-Knowledge plane as implemented on branch `mip-014/r-knowledge`
**Date:** 02 August 2026
**Verdict:** **PASS**, with two limitations stated in § 6 that must not be read as cleared

## 1. Dependency surface

| Measure | Baseline `d058544d` | Branch HEAD | Change |
|---|---|---|---|
| Production dependencies | 9 | **9** | none |
| Development dependencies | 15 | **15** | none |
| Lockfile entries | 558 | **558** | none |
| `package-lock.json` diff | — | **empty** | none |

**No dependency was added, removed, upgraded or downgraded.** The entire plane is built
from the nine packages already present. This is the single most consequential security
property of the work: an implementation that adds no dependency adds no transitive
attack surface, and requires no new supply-chain trust decision.

`npm audit --audit-level=critical` exits **0**.

## 2. Egress posture

| Control | Verification |
|---|---|
| Default embedding provider is local | `deterministic`, `model: null`; no HTTP client is constructed |
| Egress gate precedes adapter construction | Refusal paths assert `factoryInvocations === 0` |
| No Qdrant client installed | `grep` over `dependencies` and `devDependencies` returns nothing |
| No Qdrant transport ever constructed | Every one of the eight conditions-precedent refusals asserts `getTransportConstructionCount() === 0` |
| Disabled mode reads no credential | A `Proxy` trap recorded **exactly one** property read, `KNOWLEDGE_ENABLED`; a sentinel planted at `KNOWLEDGE_QDRANT_API_KEY` was never touched |
| No socket opened in disabled mode | `Socket` handle count unchanged across 20 factory invocations |

The plane in its default configuration performs **no network I/O whatsoever**. That is
not a policy statement; it is a consequence of there being no code path that constructs
a client.

## 3. Credential hygiene (CH-1 to CH-5)

| Check | Result |
|---|---|
| CH-1 No credential in source | PASS — the only credential-shaped literal is `test-key-not-a-real-credential` |
| CH-2 No credential in logs | PASS — log output asserted free of key material on every refusal path |
| CH-3 No credential in error messages | PASS |
| CH-4 No credential in health or diagnostics payloads | PASS — `getDiagnostics()` exposes provider identity, never key material |
| CH-5 No credential read when disabled | PASS — proved by the `Proxy` trap, not by inspection |

A scan of the full branch diff for live-credential patterns (`sk-live`, long bearer
tokens, JWT-shaped strings) returns **zero** matches.

## 4. Content-safety and injection posture

| Control | Design | Honest limitation |
|---|---|---|
| Structural separation | Retrieved passages sit inside a **nonce-delimited** data region; composer instructions sit outside it | This is the **primary** control and it is robust: an adversary cannot escape a region whose delimiter they cannot predict |
| Pattern screening | 12 rules, applied at admission; quarantine holds a **digest**, never the payload | **Secondary and bounded.** Rule IG-01 does **not** catch inter-character spacing evasion (`I g n o r e ...`); a test asserts this gap rather than concealing it |
| Classification ceiling | Enforced at ingestion stage I-3, **before** hashing, chunking, embedding or persistence | A refused document is never digested and never transmitted; the stage trace proves stages I-7 and I-9 were not reached |
| External-store payload | `CONFIDENTIAL` and `RESTRICTED` objects are refused by external stores; the Qdrant payload excludes `content` entirely (CT-5) | The refusal is a **successful governance outcome**, not an error to route around |

The bounded nature of pattern screening is stated in the code, in the tests and here,
because a screening layer presented as complete is worse than one presented as partial:
it invites reliance it cannot support.

## 5. Isolation from the governance and audit spine

| File | Baseline blob | Branch blob | Identical |
|---|---|---|---|
| `src/orchestrator.ts` | see `conformance-report.json` | same | **yes** |
| `src/audit/hash-chain.ts` | " | same | **yes** |
| `src/governance/mi9-gate.ts` | " | same | **yes** |

R-Knowledge imports **nothing** from `src/audit/`, holds no handle on the audit
database, participates in no orchestrator pipeline, and installs no process-level
handler. `verifyChain().ok` remains `true` throughout, including on the reverted tree.

The `canonicalStringify` used by the knowledge schema is a deliberate
re-implementation rather than an import from `hash-chain.ts`. The discipline is
identical so that a reviewer reads one convention, but the plane holds no reference to
the programme's integrity root — which ADR-K01 items 5 and 7 require.

## 6. Two limitations that must not be read as cleared

**First — the CVE position is a documentary assessment, not a live query.** The Qdrant
dependency assessment records the pinned version, digest, `undici ≥ 6.27.0` floor and
licence findings **as stated in the pre-implementation dossier**. I did not query a
vulnerability database on the date of this review. Nothing here certifies that no
advisory has been published since the dossier was written. Before any instrument
authorises installing the Qdrant client, a **fresh** CVE query is required.

**Second — SQLite is prohibited in production, and the prohibition is load-bearing.**
The reference store is authorised for test, CI and local development only. Selecting it
with `KNOWLEDGE_ENVIRONMENT_CLASS=production` refuses with
`SQLITE_PROHIBITED_IN_PRODUCTION` and creates no file — verified by asserting the target
directory byte-identical before and after. A production deployment therefore has **no
authorised store** until one is provisioned under a future instrument, and will sit at
degradation level 3. That is the intended posture, not a gap to be worked around.

## 7. Verdict

**PASS.** The plane adds no dependency, performs no egress by default, reads no
credential when disabled, holds no handle on the integrity root, and leaves the
governance spine byte-identical. The two limitations in § 6 are conditions on future
work, not defects in the present work.
