# RONOR — Release Manifest

## Release identity

| Field | Value |
|-------|-------|
| Version | `0.4.0-core-active` |
| Tag | `v0.4.0-core-active` |
| Release title | RONOR v0.4.0 — Core Active (MIP-014 R-Knowledge Merged) |
| Release date | 3 August 2026 |
| Repository | [Constantin1968/RONOR-](https://github.com/Constantin1968/RONOR-) |
| Branch | `main` |
| Release commit | `bbed8343c4341541e747942bf69c155818cbf258` |
| Previous baseline tag | `v2.1.0-baseline` |
| Programme status | CORE ENGINEERING COMPLETE → **CORE ACTIVE** threshold reached |
| Node engine | `>=20.0.0` |
| Licence | MIT |

The version string is deliberately expressed as `0.4.0-core-active` rather than a
continuation of the `2.x` build-week numbering. The `2.0.0-build-week` and
`v2.1.0-baseline` markers were hackathon-era artefacts; `0.4.0-core-active` opens
the governed engineering series in which each minor increment corresponds to one
completed MIP programme, and the pre-release qualifier records the programme
threshold reached rather than a marketing milestone.

## Programme composition

| MIP | Scope | Merge vehicle | Merge commit | Status |
|-----|-------|---------------|--------------|--------|
| SCR-001 | Align `main` with build-week (`alignment/ronor-v1`) | PR #1 | `532543d` | Merged |
| MIP-012 | Engineering templates and automation | PR #2 | `03f4a17` | Merged |
| MIP-013 | R-Sentinel operational resource intelligence | PR #3 | `d058544` | Merged |
| MIP-014 | R-Knowledge plane (STEP 2) | PR #4 | `41cbe8e` | Merged |
| MIP-015 | Qdrant client dependency and conformance update | Direct to `main` | `bbed834` | Merged |

PR #4 (`mip-014/r-knowledge` → `main`) was merged as a merge commit on
2 August 2026 at 21:19 UTC by `Constantin1968`, carrying fifteen commits across
sixty-two files with 16,062 insertions and one deletion. No pull requests remain
open against `main`.

## Verification evidence

| Check | Status | Evidence |
|-------|--------|----------|
| TypeScript strict compile | PASS | `tsc --noEmit` clean |
| Production build | PASS | `npm run build` plus postbuild asset copy |
| Test suites | PASS | 23 of 23 suites |
| Tests | PASS | **594 of 594 tests** |
| Dependency audit | PASS | `npm audit --audit-level=critical` clean |
| GitHub Actions CI | PASS | Run #10 on `bbed834`, **5 of 5 jobs green** |
| Conformance Gate G7 | PASS | 13 determinative checks, `evidence/knowledge/conformance-report.json` |
| Baseline Equivalence Gate G5 | PASS | 10 of 10 assertions, filesystem diff of zero lines |
| Checksum self-verification | PASS | `sha256sum -c` over all 191 tracked files |

The five continuous integration jobs are Security Scan, TypeScript Build,
R-Knowledge Conformance, Jest Tests, and Baseline Equivalence (R-Knowledge
disabled). Local verification was performed in a clean clone of `main` in an
isolated sandbox, independent of the GitHub runners, and reproduced every result
above.

## Test corpus

| Domain | Suites | Coverage |
|--------|--------|----------|
| Audit | 1 | Hash-chain integrity |
| Governance | 1 | MI9 Gate admission (nine findings) |
| End-to-end | 2 | Decision flow, full runtime |
| R-Sentinel | 4 | Alerts, collectors, degradation, forecaster |
| R-Knowledge | 15 | Chunker, config, degradation, deployment, deterministic and OpenAI embedding, end-to-end, equivalence, pipelines, provenance, Qdrant adapter and production path, schema, stage definitions, store-adapter integration |
| **Total** | **23** | **594 tests, all passing** |

## Key file inventory

The repository tracks 191 files at the release commit. Per-directory composition
is as follows.

| Path | Tracked files | Role |
|------|---------------|------|
| `src/` | 61 | Runtime: nine planes, model exchange, governance spine, audit chain, knowledge subsystem, sentinel subsystem, API routers |
| `docs/` | 43 | Engineering documentation, briefs, architecture reconciliation, release checklist |
| `tests/` | 24 | Jest corpus across audit, governance, e2e, sentinel and knowledge domains |
| `scripts/` | 12 | Verification, benchmarking, equivalence, rollback, checksum and SBOM tooling |
| `evidence/` | 20 | MIP-014 gate artefacts, attestations, conformance and benchmark reports |
| `.github/` | 8 | CI and release workflows, issue and PR templates, CODEOWNERS |
| `web/` | 3 | Browser interface |
| `data/`, `benchmarks/` | 2 | Scenario data and retrieval benchmark corpus |
| Repository root | 18 | Manifests, changelog, SBOM, build and container configuration |

### Critical files and digests

| File | SHA-256 |
|------|---------|
| `package.json` | `6b74d17b3f836450b0f6b64444be5a3ce2a58e18f010b25b889e1f8e0a43b071` |
| `package-lock.json` | `dfc0b36adab80b59e23aa0956c80ae8e95661ad70703062b83223dd135581c09` |
| `tsconfig.json` | `484e707156a7ff9164d1998a9284632d1d91657b0fe9d1f9d35edb769b474a69` |
| `jest.config.js` | `8ea724be156bbf1e202fba20431044ee1c82821ebe458f81e88e1ed04b5b3a91` |
| `src/index.ts` | `935f25198c68fc3cfa198f55a451357767dac2e128ca9c05afa362bb948e0273` |
| `src/audit/hash-chain.ts` | `e25172b6a776065f846eda86f218a6d6da692d51032cad3ce35bbed0408f3812` |
| `src/governance/mi9-gate.ts` | `91204c9ea2117898cf1932a47416ca9335ff6397cf1fdedf1c1798338bf12b47` |
| `.github/workflows/ci.yml` | `6e2e7e6a7d586bf83f8a8d443b50d72dd8839aadf591a76af20b6e23e0a09b0a` |
| `Dockerfile` | `fe1f8c78cc7a15522460ca2885551c442b53be0ace751488cd995ef4c1a40952` |
| `docker-compose.yml` | `6d2acc89b89799093cef67859b3355dde890d381dab28c8d145936e85f1cfc0e` |

`src/audit/hash-chain.ts`, `src/governance/mi9-gate.ts` and the orchestrator are
byte-identical to the pre-MIP-014 baseline, which is the invariant that keeps the
programme's integrity root outside the reach of the new knowledge plane.

## Release artefacts

| Artefact | Description |
|----------|-------------|
| `CHANGELOG.md` | Keep a Changelog history covering MIP-012, MIP-013, MIP-014 and MIP-015 |
| `SBOM.json` | CycloneDX 1.5 software bill of materials, 25 direct components |
| `RELEASE_MANIFEST.md` | This document |
| `checksums.sha256` | SHA-256 digest of every tracked file, with a rollup digest |
| `scripts/generate-sbom.py` | Reproducible SBOM generator |
| `scripts/generate-source-checksums.sh` | Reproducible checksum generator |

The rollup digest is recorded in the header of `checksums.sha256` itself. It is
the SHA-256 of the concatenated per-file digest column and therefore changes if
any tracked file changes, which makes it a single value to compare when auditing
a clone. The committed `checksums.sha256` covers all 191 tracked files including
the artefacts added by this release, with the necessary exception of the checksum
file itself, which cannot contain its own digest. Verify a clone with
`grep -v '^#' checksums.sha256 | sha256sum -c -`.

## Dependency surface

The production surface comprises ten packages and the development surface
fifteen, against 535 transitive packages resolved in `package-lock.json`
(lockfile version 3).

| Production dependency | Version | Licence |
|-----------------------|---------|---------|
| `@qdrant/js-client-rest` | 1.18.0 (pinned) | Apache-2.0 |
| `better-sqlite3` | ^11.1.2 | MIT |
| `cors` | ^2.8.5 | MIT |
| `dotenv` | ^16.4.5 | BSD-2-Clause |
| `express` | ^4.19.2 | MIT |
| `js-yaml` | ^4.1.0 | MIT |
| `openai` | ^4.55.0 | Apache-2.0 |
| `uuid` | ^10.0.0 | MIT |
| `winston` | ^3.13.0 | MIT |
| `zod` | ^3.23.8 | MIT |

Development dependencies are the TypeScript toolchain (`typescript`, `ts-node`,
`ts-node-dev`), the Jest stack (`jest`, `ts-jest`, `@types/jest`, `supertest`,
`@types/supertest`), `eslint`, and the type packages for `better-sqlite3`,
`cors`, `express`, `js-yaml`, `node` and `uuid`. Resolved versions, integrity
hashes and distribution URLs for all twenty-five direct components are recorded in
`SBOM.json`.

## Deployment notes

R-Knowledge is disabled by default and remains inert unless `KNOWLEDGE_ENABLED`
equals exactly the string `true`. Operators upgrading an existing deployment
therefore observe no behavioural change until they opt in. Two constraints apply
when the plane is activated: the SQLite reference store is prohibited in
production and exists for test, CI and local development only, and the Qdrant path
excludes content from its payload by design, so any deployment that depends on
content retrieval must provide a content store inside the sovereignty boundary.
The deterministic embedder is experimental infrastructure rather than production
retrieval; production activation should configure the learned embedding provider.
Environment configuration is templated in `.env.example`, and a Qdrant service
definition is provided in the compose files.

## Rollback procedure

Roll back by resetting `main` to the MIP-014 merge commit `41cbe8e` for the
pre-MIP-015 state, or to `d058544` for the pre-R-Knowledge baseline, and
redeploying. Because R-Knowledge is inert while disabled, the operationally
cheaper mitigation is to set `KNOWLEDGE_ENABLED` to any value other than `true`
and restart: the plane is then unconstructed, its routes are unmounted, and the
runtime is observationally indistinguishable from `d058544`. A rehearsed rollback
drill and verified-deletion procedure are recorded in
`evidence/knowledge/rollback-report.md`.

## Sign-off

| Role | Name | Status |
|------|------|--------|
| Engineering verification | AMB (Archeon Master the Best) | Complete — all gates PASS |
| Executive approval | Chairman, CEO | Authorised ("Go", 3 August 2026) |

---

Prepared by AMB
