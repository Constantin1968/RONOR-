# Changelog

All notable changes to RONOR will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No changes are pending. The R-Knowledge integration described under
`0.4.0-core-active` closed the last open engineering item on `main`.

## [0.4.0-core-active] — 2026-08-03

This release marks the **CORE ACTIVE** threshold for RONOR. Three consecutive
engineering programmes — MIP-012, MIP-013 and MIP-014 — are merged into `main`,
the continuous integration pipeline reports five green jobs, and the whole test
corpus passes. The runtime now carries nine planes, of which eight are
unconditionally active and one, R-Knowledge, is present but inert until it is
explicitly activated.

### Release verification summary

| Check | Result | Evidence |
|-------|--------|----------|
| Test suites | 23 passed / 23 total | `jest --runInBand` |
| Individual tests | 594 passed / 594 total | `jest --runInBand` |
| TypeScript strict compile | Clean | `tsc --noEmit` |
| Production build | Success | `npm run build` with postbuild asset copy |
| Dependency audit | Clean at critical level | `npm audit --audit-level=critical` |
| CI jobs on `main` | 5 of 5 green | Workflow run #10, commit `bbed834` |
| Conformance Gate G7 | PASS, 13 determinative checks | `scripts/verify-knowledge-conformance.ts` |
| Baseline Equivalence Gate G5 | PASS, filesystem diff of zero lines | `scripts/knowledge-equivalence.sh` |

### Added

#### MIP-012 — Engineering templates and automation

MIP-012 established the repository's engineering infrastructure without altering
runtime behaviour. It introduced the GitHub Actions continuous integration
workflow covering build, test and security scanning, together with a separate
release verification workflow that builds a tagged archive and emits SHA-256
checksums. Contribution surfaces were standardised through four issue templates
(bug report, feature request, STEP 0 assessment and Engineering Directive), a
pull request template carrying an explicit verification checklist, and a
`CODEOWNERS` file. Reproducible local development arrived via `docker-compose.yml`
with a dedicated `docker-compose.test.yml` for CI. The programme also created the
documentation and release scaffolding this changelog belongs to: `CHANGELOG.md`,
`RELEASE_MANIFEST.md`, `scripts/generate-checksums.sh`, the release checklist, the
technical review template, and the branch protection recommendations. Sixteen
files were added and two — `package.json` and `.gitignore` — were modified
additively. The test corpus stood at 43 of 43 passing at that point.

#### MIP-013 — R-Sentinel operational resource intelligence plane

MIP-013 added R-Sentinel, the plane responsible for observing and forecasting the
runtime's own resource posture. It contributes three collectors covering system,
GPU and runtime telemetry, a ring buffer for bounded retention of samples, a
forecaster, an alert engine, and a response controller that drives graduated
degradation rather than abrupt failure. The plane is surfaced through a dedicated
API router (`src/api/sentinel-router.ts`) and is wired into the runtime entry
point and the shared type surface. Four test suites accompany the plane, covering
alerts, collectors, degradation behaviour and forecasting.

#### MIP-014 — R-Knowledge plane

MIP-014 delivered a ninth plane providing governed knowledge ingestion, retrieval
and retrieval-augmented composition. **It is disabled by default and inert when
disabled.**

> Activation requires `KNOWLEDGE_ENABLED` to equal exactly the string `true`. Any
> other value — including `1`, `yes`, `TRUE`, `on` or `' true '` — leaves the
> plane unconstructed. The factory returns `null` before configuration is
> resolved, so no instance exists, no route is registered, no file or directory
> is created, no timer or socket is opened, and no credential is read.

With the plane disabled the runtime is observationally indistinguishable from
commit `d058544d`: identical route set, exactly eight planes in baseline order, an
empty filesystem diff, and no `knowledge` key in the `/health` payload. This is
verified by 42 assertions and a runtime harness that boots both modes.

The Knowledge Object contract defines fourteen mandatory fields under strict
validation, rejecting unknown top-level keys rather than stripping them, and
enforces seven invariants (K-INV-1 through K-INV-7) including recomputed
content-hash agreement, a classification ceiling, gapless chunk coverage and
computed-never-supplied provenance completeness. The deterministic embedding
adapter is byte-stable across runs, processes and host locales, defaults to
provider `deterministic` with `model: null`, refuses a dimension mismatch rather
than truncating or padding, and performs zero network egress. Three vector stores
are supported: a SQLite reference adapter restricted to test, CI and local
development and **prohibited in production**, a null store, and a Qdrant adapter.
All three are validated by one shared conformance suite with no adapter-specific
branches. A four-level degradation ladder (normal, embedding-degraded,
store-degraded, plane-unavailable) governs failure, all transitions are
reversible, and a configured store that becomes unavailable causes degradation
rather than silent substitution. Ingestion runs eleven stages with classification
screening ahead of hashing, embedding or persistence; retrieval runs eleven
stages; retrieval-augmented composition runs eight stages with a nonce-delimited
data region, refusal below an evidence-sufficiency threshold, and citations that
either resolve or are stripped. The plane exposes
`POST /api/v1/knowledge/{ingest,query,compose}` and
`GET /api/v1/knowledge/{status,quarantine}`, mounted only when enabled. Two
additive CI jobs, `baseline-equivalence` and `knowledge-conformance`, join the
three pre-existing jobs, which are unchanged.

Subsequent work on `main` completed the plane's production path: an OpenAI learned
embedding provider with deterministic fallback, a production Qdrant store using
the real client with gated collection auto-creation, Stages D, E and F covering
corpus ingestion, retrieval-augmented generation and plane integration,
deployment readiness comprising a Qdrant service definition, an environment
template and health reporting, and an end-to-end integration suite that also
corrected provider-failure propagation.

### Changed

The production dependency surface grew from nine to ten packages with the
addition of `@qdrant/js-client-rest` at pinned version `1.18.0`, recorded under
MIP-015; the development surface remains at fifteen packages. Conformance
assertions were updated in commit `bbed834` to reflect that dependency change.
The `/health` roster continues to report exactly eight planes in baseline order
even when R-Knowledge is enabled.

### Notes and limitations

The Qdrant path is not a drop-in equal of the SQLite path: its payload excludes
content by design, so `getById` and `getByHash` return `null` and content
retrieval is unsupported. A deployment that depends on content retrieval requires
a content store inside the sovereignty boundary. The deterministic embedder
remains experimental infrastructure rather than production retrieval; it captures
lexical overlap and little semantic structure, and mean reciprocal rank falls
from 0.938 to 0.692 as query and document lexical overlap falls.
`AuditHashChain`, `mi9-gate` and the orchestrator are byte-identical to the
baseline, so R-Knowledge holds no handle on the programme's integrity root.

## [2.0.0-build-week] — 2026-07-21

### Added

- Model Exchange with a nine-model registry and EMS routing
- Governance Spine with the MI9 Gate (seven-gate admission)
- SHA-256 audit hash-chain with integrity verification
- BESS Decision Loop for the Craiova 20 MWh scenario
- Exposure Analysis with financial risk quantification
- Web interface covering the BESS Decision Loop, Model Exchange and Cost Ledger
- Docker multi-stage build
- 43 tests across four suites

## [1.0.0] — 2026-07-20

### Added

- Initial RONOR architecture with seven operational planes
- R-Gateway, R-Context, R-Model Fabric, R-Agent Runtime, R-Execution, R-Assurance and R-Economics
- Basic health monitoring
- Environment configuration template

---

Prepared by AMB
