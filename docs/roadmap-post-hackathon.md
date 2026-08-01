# RONOR — Post-Hackathon Roadmap
_Anchor: Strategic Brief Layer 0–7 (canonical). Build Week baseline captured 20 July 2026._

## TL;DR (≤6 lines)

Build Week ships the governance-and-routing spine — Model Exchange (L1), MI9 Gate (L4), hash-chained audit, a BESS decision loop, and a Work Ledger — as working, tested code, not a plan. The Outcome Economics Engine, Mission State Fabric, Independent Outcome Evaluator, Evaluation Factory, AIDR layer, and Agent Passport are explicitly not delivered and move into the P0–P2 queue below. XMPro (Gartner Hype Cycle 2026, Agent Orchestration + Agentic AI) is the first named Tier-1 competitor; RONOR's differentiator is sovereignty-tier routing plus MI9 plus hash-chained audit plus the Work/Cost/Value ledger triad, none of which XMPro has. Doctrine: "Spine now, platform vision as forward-look" — the 9-plane and Layer 0–6/0–7 architectures remain R&D signal-tracked, not committed builds. Commercial track stays OSaaS pay-for-verified-gain, capped at 15% / €1,000 per day during pilot. Next hard date: P0 kickoff 5 August 2026.

## 1. Build Week baseline — what shipped

- **L1 Model Exchange — shipped.** Registry of 5 models with sovereignty tiers 1–3 (`src/model-exchange/registry.ts`); 8-rule policy filter P1–P8 (`src/model-exchange/policy.ts`); 6D EMS router — quality, sovereignty, evidence, cost, latency, operational risk (`src/model-exchange/router.ts`); 5 engine adapters, OpenAI live, Anthropic real-if-key-else-simulated, Mistral and Qwen simulated, deterministic-core live (`src/model-exchange/engines.ts`); full pipeline orchestration with policy → router → MI9 → execute → R-Assurance → audit → ledger (`src/model-exchange/orchestrator.ts`).
- **L4 MI9 Gate — shipped.** Policy loader plus 6 gates (sovereignty, safety, evidence, exposure, quality, jurisdiction) returning `allow` / `escalate` / `block` (`src/governance/mi9-gate.ts`), backed by `src/governance/policies.yaml`.
- **Audit chain — shipped.** SHA-256 hash-chained SQLite log with `append()` and end-to-end `verifyChain()` (`src/audit/hash-chain.ts`), exercised by `tests/audit/hash-chain.test.ts` and `scripts/verify-chain.ts`.
- **L7 Work Ledger — partial.** SQLite-persistent Work Ledger capturing mission, operator, task type, chosen model, tokens, cost, latency, and trace hash, plus a Cost Ledger aggregation and the R-Assurance A1–A5 check pipeline (`src/model-exchange/work-ledger.ts`). This is one leg of the intended Work/Cost-of-Intelligence/Value triad — the other two legs are not built (see Section 2).
- **BESS scenario — shipped.** 20 MWh Romania decision loop with OPCOM day-ahead and aFRR data (`src/decision-loop/bess-scenario.ts`), a GPT-5.6 proposer with deterministic fallback (`src/decision-loop/gpt-56-adapter.ts`), and an orchestrator wiring proposer → MI9 Gate → exposure analysis → audit chain (`src/decision-loop/orchestrator.ts`).
- **Web UI — shipped.** Vanilla JS operator surface with three tabs — BESS Decision Loop (timeline, chain verify, export), Model Exchange (registry table, 6D routing table, result JSON), Cost Ledger (JSON dump) (`web/`).
- **API surface — shipped.** `POST /api/v1/decisions` for governed BESS decisions (`src/api/decisions-router.ts`); `GET /api/v1/model-exchange/registry`, `POST /route`, `POST /query`, `GET /ledger/cost` (`src/api/model-exchange-router.ts`).
- **Ops and test harness — shipped.** `Dockerfile`, `railway.json`, `scripts/deploy.sh`; test suites `tests/governance/mi9-gate.test.ts`, `tests/audit/hash-chain.test.ts`, `tests/e2e/decisions.test.ts`, `tests/e2e/ronor.test.ts`.

## 2. What is deliberately not in Build Week

- **Cost of Intelligence Ledger and Value Ledger.** Only the Work Ledger leg of the triad is persisted; the other two ledgers require settlement and attribution logic not yet designed — deferred on capacity, sequenced as P0.
- **Mission State Fabric** (Frontier Task Graph, Evidence Graph, Coverage Map, Failure Memory). No component exists; this is new architecture, not an extension of shipped code — deferred on capacity and design maturity, P0.
- **Independent Outcome Evaluator**, separated from the Optimising Agent and from the Value Verifier. Build Week's R-Assurance checks are embedded in the orchestrator path, not an independent evaluator — deferred pending the Value Ledger dependency (P1).
- **Modular Evaluation Factory** (benchmark + harness + environment triad). Only ad-hoc jest tests exist today — deferred, evidence base (task corpus) not yet built, P1.
- **AIDR integration layer**, vendor-neutral, CrowdStrike as first named target. No design work started — deferred, lower priority than economics/evaluation build-out, P2.
- **Agent Passport** (static identity/jurisdiction/capability plus dynamic authority/budget/mission state). Not shipped — deferred, depends on Mission State Fabric and Model Exchange maturity, P2.
- **Interface (L3), Applications (L5), Observability (L6) beyond the web UI stub.** The current UI is a demo surface, not an operator console; applications and real observability tooling are unbuilt — deferred on capacity, sequenced after economics engine.
- **Physical AI Runtime** (Robotics Brief Layer 0–6). Feasibility-stage only; no code, no committed dev — deferred, evidence maturity too low for a build commitment.

## 3. Priority queue post-hackathon (P0/P1/P2/P3)

### P0 (start within 2 weeks of hackathon close)
- **Outcome Economics Engine — full triad** (Work + Cost of Intelligence + Value ledgers). Currently only Work Ledger persisted.
- **Mission State Fabric** — Frontier Task Graph + Evidence Graph + Coverage Map + Failure Memory.
- **Value Ledger primitive** — first-class output of every governed decision.
- **Live-provider hardening** — replace simulated Anthropic/Mistral/Qwen adapters with real API calls behind sovereignty routing.

### P1 (weeks 2–6)
- **Independent Outcome Evaluator** — separated from the Optimising Agent AND from the Value Verifier.
- **Modular Evaluation Factory** — benchmark + harness + environment triad.
- **Model-Compute Router extension** — carbon-intensity + region + compute-tier signals.
- **Interface layer (L3)** — supersede vanilla-JS demo UI with a real operator console.

### P2 (weeks 6–12)
- **AIDR integration layer** — vendor-neutral AI Detection & Response interface; CrowdStrike first target.
- **Agent Passport** — static + dynamic authority.
- **Applications layer (L5)** — first three named applications (BESS optimisation, VPP dispatch, DSO settlement).
- **Observability layer (L6)** — real metrics + trace export beyond in-app timeline.

### P3 (Q4 2026+)
- **Physical AI Runtime** (Robotics Brief Layer 0–6) — feasibility R&D only; no committed dev.
- **Full 9-plane consolidation** — decide whether Platform Brief 9-plane replaces Strategic Brief L0–7 or complements it.

## 4. Competitive landscape (updated)

| Vendor | Category | Overlap with RONOR | Differentiator RONOR has |
|---|---|---|---|
| **XMPro** | Agent Orchestration + Agentic AI ([Gartner Hype Cycle 2026](https://www.gartner.com/)) | Industrial agent orchestration for energy, utilities, manufacturing | Sovereignty-tier routing + MI9 Gate + hash-chained audit + Work/Cost/Value ledger triad. No equivalent evidence-anchoring or sovereignty routing on XMPro's side. **Tier-1 competitor.** |
| OpenAI / Anthropic / Meta (model providers) | Frontier model supply | Underlying inference capacity RONOR routes across | RONOR is model-agnostic by design; no single-provider dependency, governed fallback built in |
| DNV (bankability/certification bodies) | Governance/audit certification | Assurance of RONOR's audit chain, not a competing product | Partnership target, not a competitor |

Note: Full R&D signal tracking lives in `docs/rd-signals-tracker.md` (evidence tiers A/B/C).

## 5. OSaaS commercial track

**OSaaS Net Verified Gain (verbatim from briefing pack §6):**

> Gross value − inference/compute − tools/data − human review − security − amortisation − externalities = Net verified gain

Only this final quantity is eligible for 50/50 profit-sharing. Pilot cap: 15%, max €1,000/day.

First-pilot plan:
- Identify counterparty — target a single Romanian BESS operator already engaged through the decision-loop scenario.
- Sign a framework agreement defining baseline methodology, verification protocol, and the 15% / €1,000-day pilot cap.
- Instrument the Value Ledger against the counterparty's real dispatch data before any live routing.
- Run a 30-day dry run: RONOR proposes, human operator decides, no invoicing, chain-verified retrospectively.
- Run a 60-day live pilot: RONOR-gated decisions execute, Net Verified Gain computed and invoiced under the cap.
- Independent monthly attestation of the gain calculation before scaling to a second counterparty.

## 6. Governance & compliance track

- EU AI Act general-purpose AI (GPAI) obligations — track staged 2026–2027 provisions; build compliance dossier ahead of enforcement dates rather than reactively.
- MI9 policy iteration cadence — policies in `src/governance/policies.yaml` move through the same candidate → offline eval → security tests → MI9 approval → canary → promotion/rollback path as any other governed change; no ad-hoc edits.
- Audit-chain retention policy — define retention window and export format for the SHA-256 hash-chained log now, before pilot data accumulates.
- External audit engagement — target Q4 2026 for an independent review of the governance spine and audit chain (DNV or equivalent).
- Jurisdiction-pin extension — extend the current EU/UK data-residency default in policy P2/P8 to explicitly cover CH, NO, RO, UK, FR, DE as named jurisdictions.

## 7. Team & delivery cadence

Merlin (Constantin Liviu NITA) owns product and strategy. Plan to hire 1 backend engineer and 1 frontend engineer within the P0 window (by 5 August 2026). Cadence: weekly working sessions, fortnightly demo of shipped increments against this roadmap. No agile theatre — no story points, no standups for their own sake; the audit chain and test suites are the source of truth for "done."

## 8. Milestones (calendar)

| Date | Milestone | Owner |
|---|---|---|
| 22 Jul 2026 | Build Week submission (done or in-flight) | Merlin |
| 5 Aug 2026 | P0 kickoff, engineer hires posted | Merlin |
| 30 Sep 2026 | Outcome Economics Engine full triad delivered | Backend engineer + Merlin |
| 30 Nov 2026 | First OSaaS pilot signed | Merlin |
| 31 Dec 2026 | Independent Outcome Evaluator + Modular Evaluation Factory live | Backend + frontend engineers |
| Q1 2027 | External audit of governance + audit chain | Merlin (external: DNV or equivalent) |

## 9. Open questions

- Which is canonical long-term: Strategic Brief Layer 0–7 or Platform Brief 9-plane — replace, or maintain both with an explicit mapping?
- Do we build the Value Ledger first-party, or partner with an external settlement provider for the Net Verified Gain computation?
- What is the minimum viable Independent Outcome Evaluator — can it launch before the full Modular Evaluation Factory exists, or is the factory a hard dependency?
- How much of the Mission State Fabric (Frontier Task Graph, Evidence Graph, Coverage Map, Failure Memory) is needed before the Agent Passport's dynamic-authority component becomes meaningful?
- Is Physical AI Runtime worth tracking as an active R&D signal now, or should it stay dormant until the economics triad and evaluator are live?

_Mayleven ecosystem hierarchy: Mayleven → Ma11AI → Ronor → QMa11 → OSaaS._

— Roadmap owner: Constantin Liviu NITA (Merlin) · Last update: 20 July 2026
