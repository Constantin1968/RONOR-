# Qdrant Adapter Verification Report

**Gate:** G6
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Suite:** `tests/knowledge/qdrant-adapter.test.ts` — 37 tests, all passing
**Date:** 02 August 2026
**Verdict:** **PASS**

## 1. The scope of what is verified, stated before the results

The adapter was verified against a **fully mocked, in-process transport double**. No
Qdrant service was configured, provisioned, started, contacted, written to or
operated, and none exists in the environment.

The dossier's framing is worth restating exactly, because it is the difference
between an honest claim and an overclaim: **the mock is not a stand-in for a server
that exists elsewhere. It is the absence of a server, expressed as a module
boundary.** What this suite establishes is the adapter's **refusal logic** and its
**conformance to a pinned protocol surface**. It establishes nothing whatsoever about
how any real Qdrant server behaves, and a green result here must not be read as
readiness to operate one.

That limitation is not a shortcoming of the work; it is the shape of the authority
under which the work was done.

## 2. The eight conditions precedent (dossier § 9.1)

Seven conditions are **statically decidable** — evaluable without contacting
anything. One is not.

| # | Condition | Unsatisfied → reason code | Transport constructions on refusal |
|---|---|---|---|
| 1 | `PLANE_ENABLED` | `KNOWLEDGE_DISABLED` | **0** |
| 2 | `STORE_SELECTED` | `STORE_UNCONFIGURED` | **0** |
| 3 | `EGRESS_AUTHORISED` | `STORE_UNAUTHORISED_EGRESS` | **0** |
| 4 | `ENDPOINT_CONFIGURED` | `STORE_UNCONFIGURED` (absent) / `STORE_TLS_FAILURE` (plaintext) | **0** |
| 5 | `CREDENTIAL_PRESENT` | `STORE_AUTH_FAILURE` | **0** |
| 6 | `ENVIRONMENT_AUTHORISED` | `STORE_NOT_AUTHORISED_FOR_ENVIRONMENT` | **0** |
| 7 | `SERVER_VERSION_MATCHES` | `STORE_VERSION_MISMATCH` | 1 — see below |
| 8 | `IMPLEMENTATION_ORDER_IN_FORCE` | n/a (satisfied, recorded explicitly) | **0** |

### Zero egress is established, not asserted

For each of the seven static conditions the suite asserts three things together:

1. the refusal occurred with the correct reason code;
2. `recorder.factoryInvocations === 0`; and
3. `store.getTransportConstructionCount() === 0`.

Asserting only the reason code would leave open the possibility that a client was
constructed and a connection attempted *before* the refusal was returned. The
factory-invocation count closes that gap: **no transport object came into existence,
therefore no request could have been issued.** That counter is the operative evidence
for zero egress, and it is why the transport was made an injected seam rather than an
internal detail.

### Why condition 7 legitimately constructs a transport

`SERVER_VERSION_MATCHES` cannot be evaluated without asking the server. It is
therefore enforced in `open()`, **after** the seven static conditions have all
passed. Those seven are the gate that prevents ever reaching the dynamic check
without authorisation. Enforcement:

| Reported | Pin | Outcome |
|---|---|---|
| `v1.18.3` | `v1.18.3` | accepted |
| `v1.18.5` | `v1.18.3` | accepted — patch releases carry security fixes and should not require a code change |
| `v1.12.0` | `v1.18.3` | **refused**, `STORE_VERSION_MISMATCH` |
| `v2.18.3` | `v1.18.3` | **refused** |

### A finding on the enumeration, and why the test changed rather than the code

I initially asserted that `evaluateStaticConditions()` returns **eight** verdicts. It
returns **seven**, and that is correct. A function whose contract is to decide
without egress cannot return a verdict on a condition it is unable to decide; doing
so would be a fiction, and a caller could reasonably rely on it. The right repair was
to correct the expectation and to add a separate test proving the eighth is enforced
dynamically — not to insert a placeholder verdict so that a count would read eight.

### Multiple failures are all reported

When three conditions are unsatisfied, all three are named. An operator guided by a
diagnostic mentioning only the first failure would need as many attempts as there are
failures; reporting the full set is a materially different operator experience for no
additional cost.

## 3. Mocked-transport attestation (MTA-1 to MTA-4)

| ID | Claim | Evidence |
|---|---|---|
| MTA-1 | The default transport is the **absence** of a transport | With no factory injected and every other condition satisfied, `open()` refuses with `STORE_UNAVAILABLE` |
| MTA-1b | **Every** method of the default factory refuses | All eight transport methods enumerated and asserted to reject. A factory refusing `getServerInfo` while quietly permitting `upsertPoints` would be a hole exactly where it matters most |
| MTA-2 | No image reference, compose service, testcontainer or live endpoint literal in adapter source | Static scan over five files, comments stripped |
| MTA-2b | No Qdrant package in `dependencies` or `devDependencies`; counts remain 9 and 15 | `package.json` inspected |
| MTA-2c | No container manifest declares a Qdrant service | All four manifests scanned and proved byte-identical to baseline |
| MTA-3 | No Qdrant process is running | `ps aux` inspected |
| MTA-4 | Even the success path performs no network I/O | The double is in-process; every operation was recorded by it |

### Two framing corrections made during verification

**MTA-2 initially scanned raw file text** and failed on the mock helper, whose prose
states that it is "not an emulator, a simulator, a stub server, a testcontainer, a
compose service or a proxy". That prose is the *documentation of the constraint*, not
a violation of it. Scanning raw text conflated the two, so the scan now strips
comments — the same discipline applied to the isolation assertions at G5.

**MTA-2c initially asserted that no container manifest exists in the repository.**
That claim is false and was badly framed: `Dockerfile`, `docker-compose.yml`,
`docker-compose.test.yml` and `.dockerignore` are all present in baseline
`d058544d`, entirely unrelated to MIP-014. The precise claim is that **no manifest
declares a Qdrant service**, and that this work added and modified none. Both are now
asserted, the latter by blob-hash comparison against the baseline. A test that fails
on pre-existing infrastructure is a badly stated claim, not a finding.

## 4. Vendor neutrality (N-1 to N-8)

| ID | Invariant | Result |
|---|---|---|
| N-1 | Implements the unmodified `VectorStore` interface | PASS — all eleven members present |
| N-2 | No Qdrant identifier in the plane, router or any pipeline | PASS — ten files scanned over executable code |
| N-3 | Store selected by configuration, never a hard-coded default | PASS |
| N-4 | No vendor-specific field in the Knowledge Object | PASS — no key matching `point`, `payload`, `collection` |
| N-5 | Capabilities declared and frozen; ceiling `INTERNAL` | PASS |
| N-6 | Covered by the same shared conformance suite as every other store | PASS |
| N-7 | Pins confer no authority to operate | PASS — pins present, transport constructions 0 |
| N-8 | Telemetry disablement carried from the operator environment | PASS — see below |

**N-8 required correcting my expectation, and the correction matters.** I first
asserted `telemetryDisabled === true` unconditionally. The field reflects
`QDRANT__TELEMETRY_DISABLED`, a **server-side** variable, and it is `false` by
default. Making the resolver return `true` regardless of the environment would have
produced a green test attesting to a server configuration **nobody had verified** —
the application cannot disable telemetry on a server it does not operate. Telemetry
disablement is an operator obligation recorded in a deployment record; the field
reports whether the operator declared it. The test now asserts both the default and
the declared case.

## 5. Credential hygiene (CH-1 to CH-5)

| ID | Claim | Result |
|---|---|---|
| CH-1 | No credential in any refusal detail | PASS |
| CH-2 | No credential in diagnostics, health, stats or condition verdicts | PASS |
| CH-3 | The config records **presence only**, never the material | PASS — `apiKeyPresent: boolean` |
| CH-4 | The redactor removes bearer tokens, api-key assignments, JWTs and long opaque strings | PASS |
| CH-5 | The credential is read at call time and never retained on the adapter | PASS — full serialisation of the instance contains no secret |

Recording presence as a boolean rather than carrying the value is the decisive
choice here. A configuration object is passed, logged and serialised in many places;
a credential inside it would leak **by default**, and every one of those places would
have to remember to redact. A boolean cannot leak.

The redactor is deliberately aggressive, including a catch-all for opaque strings of
40 characters or more. It will sometimes redact something innocuous. That is the
correct trade: a marginally less informative diagnostic is a far smaller cost than a
live credential in a log aggregator.

## 6. Payload minimisation and classification refusal

| Rule | Claim | Result |
|---|---|---|
| CT-7 | `CONFIDENTIAL` and `RESTRICTED` objects are **refused**, never transmitted | PASS — `STORE_CLASSIFICATION_REFUSED`; the double received nothing |
| CT-5 | The transmitted payload **excludes** content | PASS — a distinctive sentence was asserted absent from everything the double received |
| CT-5b | Consequently `getById` returns `null` rather than a partial object | PASS |

The refusal at CT-7 is a **successful governance outcome**, not an error to be worked
around. The store's declared ceiling is `INTERNAL`, and the boundary holds at the
adapter rather than depending on a caller to check first.

### A capability limitation, stated plainly

Because the payload excludes content under CT-5, **a Knowledge Object cannot be
reconstituted from the Qdrant store alone.** The consequences are:

- the Qdrant path supports **vector search** and **duplicate detection**;
- it does **not** support content retrieval;
- `getById` and `getByHash` therefore return `null` rather than a partially
  reconstituted object.

Returning a partial object would fail integrity verification at retrieval and
present as corruption; `null` is the honest answer. This means **the Qdrant path is
not a drop-in equal of the SQLite path**, and any deployment relying on content
retrieval requires a content store inside the sovereignty boundary. This is asserted
as a test (CT-5b) rather than left in a comment, so that a future change which
appears to "fix" `getById` will fail loudly.

## 7. Protocol helpers

`isAbsoluteHttpsUrl` requires TLS and an absolute form, and rejects a URL that merely
*contains* the substring `https` (`ftp://host/https://x` → false). `versionMatchesPin`
compares major and minor while tolerating a patch difference.

## 8. Result

| Measure | Value |
|---|---|
| Tests in this suite | **37 passing** |
| Knowledge suites total | 10 suites, **318 tests** passing |
| Pre-existing corpus | 8 suites, **137/137** passing, unchanged |
| Dependencies | 9 production, 15 development — unchanged |
| Transport constructions on any refusal path | **0** |
| Qdrant services configured, provisioned, started, contacted, written, operated | **0** |

**GATE G6 VERDICT: PASS**

## 9. Related evidence

| File | Contents |
|---|---|
| `qdrant-dependency-assessment.md` | Requirement 9b: pins, digest, `undici` floor, licences, CVE position, and the declared deviation on non-installation |
| `mocked-transport-attestation.txt` | Signed negative attestation |
| `../../tests/knowledge/qdrant-adapter.test.ts` | The 37 assertions |
