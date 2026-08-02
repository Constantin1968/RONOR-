# Qdrant Dependency Assessment

**Requirement:** Pre-Implementation Dossier § 9b
**Authority:** MIP-014-EO-STEP2 Rev 2, validated by MIP-014-EO-STEP2-VAL-001
**Gate:** G6
**Date:** 02 August 2026

## 1. Summary and declared deviation

The Execution Plan anticipated the dependency surface moving from **9 to 10**
production dependencies and the lockfile from **558 to 561** entries, with
`@qdrant/js-client-rest@1.18.0` installed.

**The client has NOT been installed.** The dependency surface remains:

| Measure | Baseline | Current | Plan expectation |
|---|---|---|---|
| Production dependencies | 9 | **9** | 10 |
| Development dependencies | 15 | **15** | 15 |
| Lockfile entries | 558 | **558** | 561 |

This is a **declared deviation**, disclosed here and in the STEP 2 Final Report
rather than discovered in a manifest.

### Reasoning

The Order authorises adapter development against a **fully mocked transport only**,
and prohibits configuring, provisioning, starting, contacting, writing to or
operating any Qdrant service (MT-1 to MT-8). Installing a live HTTP client into the
production dependency set would place in the repository a capability the Order
withholds — an artefact whose only function is to open connections, in a programme
whose current authorisation is that no connection may be opened.

It would also confer **no verification benefit**. Every assertion under gate G6 is
satisfied by the in-process double: the eight conditions precedent, the zero-egress
seam, credential hygiene, payload minimisation and classification refusal are all
properties of the *adapter*, not of any client library. A test that imported the
real client and never called it would prove nothing that the double does not already
prove.

What requirement 9b actually demands is an **assessment** — pins, digest, transitive
floor, licences, CVE position — and an assessment is a document. That document is
this one.

### How installation remains available without rework

The adapter is written against a substitutable transport seam:

```
QdrantVectorStore(config, transportFactory?: QdrantTransportFactory)
```

The default is `UNAVAILABLE_TRANSPORT_FACTORY`, an object whose every method
refuses. A future instrument authorising live operation can add the client and
supply a real factory **without modifying the adapter**, because the adapter never
names the client. The pinned values below are recorded so that such an instrument
inherits the assessment rather than repeating it.

## 2. Pinned reference values

| Artefact | Pin | Form |
|---|---|---|
| Server | `v1.18.3` | exact version, major/minor enforced |
| Server image digest | `sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286` | digest, not a tag |
| Client | `@qdrant/js-client-rest@1.18.0` | **exact**, no semver range |
| Transitive HTTP floor | `undici >= 6.27.0` | floor; assessed release 6.28.0 |

Two notes on why these forms were chosen. The image is pinned by **digest rather
than tag** because a tag is mutable: `qdrant/qdrant:v1.18.3` can be repointed by its
publisher, so a tag pin is an assertion about a name rather than about bytes. The
client is pinned **exactly, with no caret**, because a caret range permits a minor
upgrade to be introduced by an unrelated `npm install`, and a change to the component
that performs egress should require an explicit decision.

These values fix a **protocol surface for writing the adapter**. Their presence
confers **no authority** to obtain, run, reach or operate any server bearing them
(Order Article 3.1; dossier § 0.2). The G6 suite asserts this directly: with every
pin present and all seven static conditions satisfied, the default factory still
refuses and the transport construction count remains zero.

## 3. Version-pin enforcement

The adapter enforces the server pin at `open()`, after the seven static conditions
have authorised transport construction:

- Major and minor must agree — `v1.12.0` against a `v1.18.3` pin is **refused**
  with `STORE_VERSION_MISMATCH`.
- A patch difference is tolerated — `v1.18.5` is accepted, since patch releases
  carry security fixes that should not require a code change to adopt.
- A major difference is refused — `v2.18.3` is refused.

This is condition 7 of the eight, and it is the one condition that is **not
statically decidable**: it cannot be evaluated without asking the server. That is
why `evaluateStaticConditions()` returns seven verdicts rather than eight, and why
the seven must all pass before a transport may exist — they are the gate that
prevents reaching the dynamic check unauthorised.

## 4. Licence position

| Component | Licence | Assessment |
|---|---|---|
| Qdrant server | Apache-2.0 | Permissive; no copyleft obligation on the calling application |
| `@qdrant/js-client-rest` | Apache-2.0 | Permissive |
| `undici` | MIT | Permissive |

No component carries a reciprocal or network-copyleft obligation (AGPL, SSPL) that
would attach to the RONOR runtime. Note for completeness: Qdrant Cloud and certain
enterprise features are licensed separately from the Apache-2.0 server, and nothing
in this assessment extends to them.

## 5. CVE and vulnerability position

**As of the current dependency surface:** `npm audit --audit-level=critical` exits 0.
Because no Qdrant client is installed, the runtime carries **no vulnerability
exposure whatsoever** from this dependency family. That is the strongest statement
available about the current state and it is a direct consequence of the deviation
recorded in § 1.

**For a future instrument authorising installation,** the `undici >= 6.27.0` floor
is the operative constraint. Releases below that floor carry known issues in HTTP
handling; the floor exists so that the transitive dependency cannot be resolved to a
vulnerable release by an unrelated install. An instrument authorising the client
should:

1. Verify the floor is satisfied in the resolved lockfile, not merely declared.
2. Re-run `npm audit --audit-level=critical` and record the result.
3. Confirm the client's own transitive tree introduces no additional HTTP stack.

**Limitation stated plainly:** this assessment reports the pinned floor and the
licence position from the dossier's recorded values. It does **not** constitute a
live CVE database query performed at this date, and it should not be read as
certifying that no advisory has been published against these versions since the
dossier was prepared. A live query is an obligation of the instrument that authorises
installation, at the date of installation.

## 6. Transitive surface

`@qdrant/js-client-rest` brings a REST transport built on `undici`. Since neither is
installed, the current transitive surface attributable to this family is **empty**.
The lockfile delta the plan anticipated (558 → 561, i.e. three entries: the client,
`undici`, and one further transitive) is therefore **not present**, and the absence
is verifiable: `git ls-files` shows no lockfile change, and `package.json` declares
no package matching `/qdrant/i`.

## 7. Verification

Asserted by test in `tests/knowledge/qdrant-adapter.test.ts`:

| Assertion | Test |
|---|---|
| No package matching `/qdrant/i` in dependencies or devDependencies | MTA-2b |
| Dependency counts remain 9 and 15 | MTA-2b |
| No container manifest declares a Qdrant service | MTA-2c |
| All three pre-existing container manifests byte-identical to baseline | MTA-2c |
| No Qdrant process running in the environment | MTA-3 |
| Pins present and inert — zero transport constructions | N-7 |
| Every method of the default factory refuses | MTA-1b |
