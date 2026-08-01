# RONOR Architecture Reconciliation
_Build Week 2026 · anchored to Strategic Brief Layer 0–7_

## TL;DR

Five architecture descriptions exist for RONOR (as-shipped TypeScript, Model Exchange v0.1, Platform Brief 9-plane, Robotics Brief Layer 0–6, Strategic Brief Layer 0–7). This doc maps all four onto the fifth as the single canonical frame, per the [briefing pack](_briefing-pack-pas3-pas4.md). **Canonical answer: the Strategic Brief's Layer 0–7 (`docs/qma11-strategic-brief-18jul2026.md`) is the anchor** — Build Week 2026 ships Layer 1 (Model Exchange) and Layer 4 (MI9 Governance) in full, plus a Layer 7 partial (Work Ledger). Everything else in E, and all of C and D, is forward-look.

## 1. Why five architectures exist

The five descriptions were produced at different times, by different authors, for different audiences: the Model Exchange v0.1 ZIP (B) was an early standalone prototype focused only on routing; the as-shipped TypeScript repo (A) grew out of B but was restructured around a 7-plane runtime shape (`src/index.ts`) while also carrying the original `src/model-exchange/` module tree unchanged; the Platform Brief (C) and Robotics Brief (D) are QMa11 forward-vision documents written to explore a 9-plane and a Layer 0–6 embodied-AI framing respectively, independent of what build week could ship; the Strategic Brief (E) was written last, on 18 July 2026, explicitly to be the canonical Layer 0–7 frame that supersedes and contains the others. Reconciling now matters because the submission narrative, the roadmap update (Pas 4), and future engineering must reference one map, not five overlapping vocabularies. Without reconciliation, reviewers cannot tell what is shipped code versus aspirational architecture, and internal teams risk building against inconsistent layer names.

## 2. Canonical anchor: Strategic Brief Layer 0–7

Source: [`docs/qma11-strategic-brief-18jul2026.md`](qma11-strategic-brief-18jul2026.md), "Updated RONOR target architecture (canonical)".

| Layer | One-line purpose |
|---|---|
| L0 — Operational Reality Fabric | Raw operational substrate: SCADA, IoT, markets, documents, contracts, assets, humans, robots, digital twins. |
| L1 — Model and Compute Sovereignty | Model Exchange: selects model + compute environment across sovereignty tiers and jurisdictions. |
| L2 — Mission State Fabric | Persistent shared state: mission frontier, evidence graph, coverage map, failure memory, budget/approvals. |
| L3 — Multi-Agentics Runtime | Agent identity, capability registry, delegation, model–compute routing, skills/tools/memory. |
| L4 — Runtime Security and Authority | Governance Spine: continuous identity, AIDR integration, tool/network policy, deterministic gateways — Build Week ships MI9 Gate + Exposure Analysis + hash chain here. |
| L5 — Digital and Physical Workers | The workers themselves: enterprise, public-sector, energy workers, drone swarms. |
| L6 — Independent Evaluation | Benchmarks, harnesses, simulators, red-cell testing, reward-hacking detection, failure attribution. |
| L7 — P2I / OSaaS Economics | Work/Cost-of-Intelligence/Value ledgers, counterfactual analysis, Net Verified Gain — Build Week ships a Work Ledger partial here. |

## 3. Reconciliation matrix

| Strategic Brief Layer (E) | Build-week TypeScript (A) | Model Exchange v0.1 (B) | Platform Brief 9-plane (C) | Robotics Brief Layer 0–6 (D) | Shipped? |
|---|---|---|---|---|---|
| L0 Operational Reality Fabric | Implicit only — `src/decision-loop/bess-scenario.ts` (OPCOM DAM + aFRR data) | none | R-Gateway (ingress, no OT layer) | L0 Physical | partial |
| L1 Model and Compute Sovereignty | `src/model-exchange/registry.ts`, `policy.ts`, `router.ts`, `engines.ts` | `registry.js`, `policy.js`, `router.js`, `engines.js` | R-Model-Fabric | L5 Model Exchange | shipped |
| L2 Mission State Fabric | not present | not present | R-Context (context mgmt/compression only — not full state fabric) | none | roadmap |
| L3 Multi-Agentics Runtime | `src/planes/r-agent-runtime/` (init-only stub), `src/orchestrator.ts` | none | R-Agent-Runtime | L6 Mission ops (partial overlap) | partial |
| L4 Runtime Security and Authority | `src/governance/mi9-gate.ts`, `governance/policies.yaml`, `src/audit/hash-chain.ts` | none | Governance-Spine (crosscut) | L4 MI9 | shipped |
| L5 Digital and Physical Workers | none (BESS scenario is a use case, not a worker abstraction) | none | not modeled as a plane | L0 Physical / L1 Sensors (embodied workers) | R&D signal |
| L6 Independent Evaluation | `tests/governance/mi9-gate.test.ts`, `tests/audit/hash-chain.test.ts`, `tests/e2e/*.test.ts` (ad-hoc jest only) | `test_e2e.py` (reference repo only) | R-Assurance (evaluation sub-scope only) | none | partial |
| L7 P2I / OSaaS Economics | `src/model-exchange/work-ledger.ts` (Work Ledger + Cost Ledger aggregations + R-Assurance A1–A5) | `server/ledger.js` (reference only) | R-Economics, R-Assurance | L4 MI9 (governance overlap only) | partial |

Note: `src/planes/r-gateway/`, `r-context/`, `r-model-fabric/`, `r-agent-runtime/`, `r-execution/`, `r-assurance/`, `r-economics/` exist as init-only stubs wired in `src/index.ts` and `src/orchestrator.ts`; they mirror C's 9-plane naming but do not carry C's or E's full functional scope. Per the [briefing pack](_briefing-pack-pas3-pas4.md), the functionally complete, tested code lives in `src/model-exchange/`, `src/governance/`, `src/audit/`, `src/api/`, and `src/decision-loop/`.

## 4. Nomenclature crosswalk (short)

| Concept | A (as-shipped) | B (Model Exchange v0.1) | C (9-plane) | D (Robotics L0–6) | E (canonical) |
|---|---|---|---|---|---|
| Model routing | `src/model-exchange/router.ts` (6D EMS) | `server/router.js` | R-Model-Fabric | L5 Model Exchange | L1 Model and Compute Sovereignty |
| Governance/policy gate | `src/governance/mi9-gate.ts` ("MI9 Gate") | none | Governance-Spine (crosscut) | L4 MI9 | L4 Runtime Security and Authority |
| Audit trail | `src/audit/hash-chain.ts` | none | Observability (crosscut, partial) | none | L4 (subsumed) |
| Ledger/economics | `src/model-exchange/work-ledger.ts` (Work Ledger) | `server/ledger.js` | R-Economics | L4 MI9 (loose overlap) | L7 P2I/OSaaS Economics |
| Quality/evidence checks | R-Assurance 5-check pipeline (A1–A5, in `work-ledger.ts`) | none | R-Assurance (plane) | none | L6 Independent Evaluation (partial) / L7 (evidence field) |

## 5. Decisions locked for Build Week

- Anchor is Strategic Brief Layer 0–7 (`docs/qma11-strategic-brief-18jul2026.md`); C and D are subordinate forward-look framings, not competing canons.
- Model Exchange (`src/model-exchange/`) = L1 Model and Compute Sovereignty, shipped.
- Governance Spine (`src/governance/`, `src/audit/`) = L4 Runtime Security and Authority, shipped.
- Work Ledger (`src/model-exchange/work-ledger.ts`) = L7 P2I/OSaaS Economics, partial only — Cost of Intelligence Ledger and Value Ledger are not built.
- 9-plane (C) and Robotics Layer 0–6 (D) are forward-look; no plane or layer in C/D that is absent from the "delivered" list in the briefing pack ships in Build Week.
- The `src/planes/*` stub folders are retained as scaffolding toward C's plane names but carry no delivered functional scope beyond init lifecycle.
- BESS decision loop (`src/decision-loop/`) is a use-case demonstrator spanning L1/L4/L7, not a distinct layer.
- Mission State Fabric (L2), Independent Evaluation beyond ad-hoc tests (L6), and the Digital/Physical Workers abstraction (L5) remain unshipped roadmap items.
- "Spine now, platform vision as forward-look" is the doctrine governing all reconciliation calls in this document.

## 6. What ships vs. what is forward-look

**Shipped in Build Week:**
- Model Exchange: `registry.ts`, `policy.ts` (P1–P8), `router.ts` (6D EMS), `engines.ts` (5 adapters), `work-ledger.ts`
- Governance Spine: `mi9-gate.ts` (6 gates), `policies.yaml`, `audit/hash-chain.ts`, `api/decisions-router.ts`, `api/model-exchange-router.ts`
- BESS decision loop: `bess-scenario.ts`, `gpt-56-adapter.ts`, `decision-loop/orchestrator.ts`
- Web UI (`web/`): BESS Decision Loop, Model Exchange, Cost Ledger tabs
- Ops/tests: `Dockerfile`, `railway.json`, `scripts/verify-chain.ts`, `scripts/benchmark.ts`, jest suites under `tests/`

**Forward-look R&D (per briefing pack, NOT delivered):**
- Cost of Intelligence Ledger and Value Ledger (separate from Work Ledger)
- Mission State Fabric (Frontier Task Graph, Evidence Graph, Coverage Map, Failure Memory)
- Independent Outcome Evaluator (distinct from Optimising Agent and Value Verifier)
- Modular Evaluation Factory (benchmark + harness + environment triad)
- AIDR integration layer (CrowdStrike or vendor-neutral)
- Agent Passport (static + dynamic authority)
- Physical AI Runtime (Robotics Brief Layer 0–6) — R&D only
- Layer 3/5 (Interface / Applications / Observability) beyond the web UI stub

## 7. Open reconciliation debts

- R-Assurance appears both as a Model Exchange pipeline stage (A1–A5 in `work-ledger.ts`) and as a 9-plane plane (C) — needs one designated home before Pas 4.
- The `src/planes/*` stub directories duplicate C's plane names but not C's scope — decide whether to delete, rename, or formally scope them as L3/L6 scaffolding.
- Robotics Brief (D) uses its own Layer 0–6 labels (R-Data & OT, R-Edge Safe Runtime, etc. in the source document) that differ from the labels used in the briefing pack summary (L0 Physical, L1 Sensors, etc.) — the two D naming sets need to be unified.
- "Governance Spine" is used interchangeably for the L4 layer, the crosscut in C, and the MI9 Gate module itself — needs one formal term across docs.
- Ownership of "Model–Compute Router extension" (briefing pack item 2) is unclear: is it an L1 extension or a new L3 capability given its ties to Agent Passport and delegation.
- No single doc yet states whether `src/orchestrator.ts` (top-level) or `src/model-exchange/orchestrator.ts` is the authoritative orchestration entry point — both exist and both are wired into `src/index.ts`.

— Author: Constantin Liviu NITA (Merlin) · Ma11AI · Mayleven Ecosystem
