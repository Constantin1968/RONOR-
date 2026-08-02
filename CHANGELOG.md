# Changelog

All notable changes to RONOR will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### R-Knowledge plane (MIP-014 STEP 2)

A ninth plane providing governed knowledge ingestion, retrieval and
retrieval-augmented composition. **Disabled by default and inert when disabled.**

- **Activation.** `KNOWLEDGE_ENABLED` must equal exactly the string `true`. Any other
  value — including `1`, `yes`, `TRUE`, `on` or `' true '` — leaves the plane
  unconstructed. The factory returns `null` before configuration is resolved, so no
  instance exists, no route is registered, no file or directory is created, no timer
  or socket is opened, and no credential is read.
- **Baseline equivalence.** With the plane disabled the runtime is observationally
  indistinguishable from commit `d058544d`: identical route set, exactly eight planes
  in baseline order, empty filesystem diff, and no `knowledge` key in the `/health`
  payload. Verified by 42 assertions and a runtime harness that boots both modes.
- **Knowledge Object contract.** Fourteen mandatory fields under strict validation;
  unknown top-level keys are rejected rather than stripped. Seven invariants
  (K-INV-1 to K-INV-7) including recomputed content-hash agreement, classification
  ceiling, gapless chunk coverage and computed-never-supplied provenance completeness.
- **Deterministic embedding adapter.** Byte-stable across runs, processes and host
  locales; default provider `deterministic` with `model: null`; refuses a dimension
  mismatch rather than truncating or padding. Zero network egress.
- **Vector stores.** SQLite reference adapter (test, CI and local development only —
  **prohibited in production**), a null store, and a Qdrant adapter verified against a
  fully mocked in-process transport. All three validated by one shared conformance
  suite with no adapter-specific branches.
- **Degradation ladder.** Four levels (normal, embedding-degraded, store-degraded,
  plane-unavailable), all transitions reversible. A configured store that is
  unavailable causes degradation and is never silently substituted.
- **Pipelines.** Eleven-stage ingestion with classification screening before hashing,
  embedding or persistence; eleven-stage retrieval; eight-stage RAG composition with a
  nonce-delimited data region, refusal below an evidence-sufficiency threshold, and
  citations that either resolve or are stripped.
- **API.** `POST /api/v1/knowledge/{ingest,query,compose}` and
  `GET /api/v1/knowledge/{status,quarantine}`, mounted only when the plane is enabled.
- **CI.** Two additive jobs, `baseline-equivalence` and `knowledge-conformance`. The
  three pre-existing jobs are unchanged.

#### R-Knowledge notes and limitations

- The **Qdrant path is not a drop-in equal of the SQLite path**: its payload excludes
  content by design, so `getById` and `getByHash` return `null` and content retrieval
  is unsupported. A deployment relying on content retrieval requires a content store
  inside the sovereignty boundary.
- **No Qdrant client is installed** and no Qdrant service was configured, provisioned,
  started, contacted, written to or operated. The dependency surface is unchanged at 9
  production and 15 development packages.
- The deterministic embedder is **experimental infrastructure, not production
  retrieval**. It captures lexical overlap and little semantic structure; mean
  reciprocal rank falls from 0.938 to 0.692 as query/document lexical overlap falls.
- `AuditHashChain`, `mi9-gate` and the orchestrator are **byte-identical** to the
  baseline. R-Knowledge holds no handle on the programme's integrity root.

#### Pre-existing entries

- GitHub Actions CI pipeline (build, test, security scan)
- Docker Compose for reproducible local development
- Issue templates (bug report, feature request, STEP 0, Engineering Directive)
- Pull request template with verification checklist
- CODEOWNERS file
- Release verification workflow with checksum automation
- CHANGELOG structure
- Release manifest template
- Engineering documentation (release checklist, technical review template, branch protection)

## [2.0.0-build-week] — 2026-07-21

### Added
- Model Exchange with 9-model registry and EMS routing
- Governance Spine with MI9 Gate (7-gate admission)
- SHA-256 audit hash-chain with integrity verification
- BESS Decision Loop (Craiova 20 MWh scenario)
- Exposure Analysis with financial risk quantification
- Web interface (BESS Decision Loop, Model Exchange, Cost Ledger)
- Docker multi-stage build
- 43 comprehensive tests across 4 test suites

## [1.0.0] — 2026-07-20

### Added
- Initial RONOR architecture with 7 operational planes
- R-Gateway, R-Context, R-Model Fabric, R-Agent Runtime, R-Execution, R-Assurance, R-Economics
- Basic health monitoring
- Environment configuration template
