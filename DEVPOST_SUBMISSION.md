# RONOR — Devpost Submission
_OpenAI Build Week 2026 · Work & Productivity_

## Project name
**RONOR — Model Exchange & Governance Spine for Energy Operations**

## Category
**Work & Productivity** — the operator work being productivised is BESS dispatch, DSO settlement, and energy-trading decisions across a portfolio of frontier models.

## One-line pitch
Five models, one governed pipeline, and an audit chain any regulator can verify from the command line.

---

## Elevator pitch

I run a small AI-and-energy consultancy in Bucharest. Every operator I talk to says the same thing: they cannot deploy AI they cannot audit. So over Build Week I built the thing they keep asking for.

RONOR is a Node/TypeScript runtime that puts five engines — GPT-4.1, Claude Sonnet 4, Mistral Large 2, Qwen3-72B, and a local Deterministic Core — behind one Unified Request API. A deterministic policy layer (eight rules, P1–P8) filters the registry before scoring. A six-dimension router then picks the winner on quality, sovereignty, evidence, cost, latency, and operational risk. Around that router sits the MI9 Gate: six pre-execution checks that return allow, escalate, or block, plus five post-execution checks on the output. Every request, verdict, cost, and result is appended to a SHA-256 hash-chained SQLite audit log — one CLI command verifies the whole chain. A realistic 20 MWh Romanian BESS scenario on OPCOM day-ahead and aFRR data runs end-to-end through the same pipeline.

---

## Inspiration

Two things pushed me into this.

The first is that energy operators in the EU are now converged on a very uncomfortable position: REMIT II, the EU AI Act's general-purpose obligations, and their own sector regulators all assume they can explain and reproduce every automated decision. Most AI tooling in the market today cannot pass that bar.

The second is the model landscape itself. Frontier providers have converged on similar capabilities but diverged wildly on cost, latency, jurisdiction, and evidence quality. Nobody should pick one provider per contract. You pick one per request. Every single-provider AI stack I looked at fails one of those two tests. RONOR is designed to fail neither.

## What it does

- **Model Exchange.** Five engines behind one Unified Request API. Registry, deterministic policy filter (P1–P8), six-dimension router with a published scoring formula: `Quality + Sovereignty + Evidence − Cost − Latency − Risk`, then engine execution with automatic fallback to the next-ranked engine on failure.
- **Governance Spine.** MI9 Gate runs six pre-execution checks (sovereignty, safety, evidence, exposure, quality, jurisdiction), and returns `allow`, `escalate`, or `block`. Post-execution, R-Assurance runs five more checks (A1–A5). Both are wired around the router, not bolted on after.
- **Audit chain.** Every request, verdict, and result is appended to a SHA-256 hash-chained SQLite log. `npx tsx scripts/verify-chain.ts` walks the chain end-to-end and reports any gap, fork, or tamper.
- **Work Ledger + Cost Ledger.** Every governed query writes tokens, USD cost, latency, simulation flag, and verified confidence. Aggregations by model and task type. This is the raw feed for the settlement model I use commercially (OSaaS — net verified gain).
- **BESS decision loop.** A 20 MWh Romania scenario over OPCOM DAM and aFRR data, wired through the same governance spine.
- **Operator UI.** Three tabs (BESS Decision Loop, Model Exchange, Cost Ledger) with a live audit-chain badge in the header.

## How I built it

- **Runtime.** Node.js + TypeScript. Express for HTTP. SQLite via `better-sqlite3` for both the audit chain and the Work Ledger — one file, one process, no external database dependency.
- **Model Exchange layer.** Six files under `src/model-exchange/`: `registry.ts`, `policy.ts`, `router.ts`, `engines.ts`, `work-ledger.ts`, and `orchestrator.ts`. The orchestrator is the whole pipeline in one call: policy → route → MI9 → execute → assure → audit → ledger.
- **Governance Spine.** `src/governance/mi9-gate.ts` reads `src/governance/policies.yaml`. `src/audit/hash-chain.ts` handles append and verify.
- **BESS.** `src/decision-loop/bess-scenario.ts`, `gpt-56-adapter.ts`, `orchestrator.ts`. GPT-5.6 is the proposer. A deterministic fallback keeps the demo runnable without network.
- **UI.** Vanilla JavaScript. No framework. Nexus palette. Satoshi for headings, JetBrains Mono for structured data.
- **Ops.** Dockerfile, `railway.json`, `scripts/deploy.sh` for Railway. Jest for the tests (43 passing at submission).

## OpenAI usage

- **GPT-4.1** is one of the five live engines in the exchange. When the router picks it, the request executes against the real API, the response goes through R-Assurance, and the full trace — tokens, USD cost, latency, routing rationale — lands in the audit chain.
- **GPT-5.6** is the live BESS decision-loop proposer. It emits a structured recommendation which then goes through the MI9 Gate before anything else looks at it.
- **Codex** wrote the first version of the orchestration pipeline, the router scoring implementation, the audit-chain append and verify path, and most of the operator UI. I reviewed, tested, and edited every generated file before it was committed. Nothing was accepted blindly.

## Challenges I ran into

- **Two parallel codebases to reconcile.** I had a prior submission (`RONOR_Model_Exchange_v0.1_Final_Verified`) that shipped a Node/Express + React/Vite Model Exchange with an in-memory ledger. The Build Week repo already had the governance spine, hash-chain audit, and BESS scenario. Merging them without duplicating logic meant porting the exchange logic into TypeScript so it could share the audit chain, Work Ledger, and MI9 Gate with the rest of the stack.
- **A policy false-positive that took me longer than I want to admit.** MI9 Gate 1 kept blocking deterministic-core queries. Root cause: the model's declared jurisdictions were `["sovereign"]`, a value the default residency policy did not recognise as an EU zone. Fixed in the orchestrator — sovereign and self-hosted models now map to `eu`, since Ronor is Romania/UK-based.
- **A runtime asset that never made it into the build.** `policies.yaml` was in `src/governance/` but not being copied into `dist/`. A one-line `postbuild` fix, but the kind of thing that breaks a demo the first time you run it from a container.
- **A test-isolation bug caused by a hoisted constant.** `AUDIT_DB_PATH` was resolved at module load, so the scratch-DB fixtures in one test file were being ignored. Moved the resolution inside `getDb()`. Not glamorous. Necessary.

## Accomplishments I am proud of

- The whole pipeline is a single `runUnifiedQuery` call. Nothing is deferred to the UI or the caller. That means a CLI, a cron job, and the operator console all get the same governance.
- Every number the operator sees on screen is anchored to a chain hash they can verify from the command line, without me in the loop.
- The Deterministic Core runs at 1 ms, zero cost, and 100% verified confidence. So when the router's job is a calculation, it genuinely picks the cheapest correct answer — not the most impressive one. That behaviour was the whole point.

## What I learned

- Governance should sit around the router, not after it. If MI9 runs after execution, you have already spent tokens on a request you were going to reject.
- Sovereignty is a router dimension, not a filter. Treating it as a weighted term (0.7) makes it composable with cost and latency instead of being a hard yes/no.
- An audit chain is a product feature, not compliance overhead. Regulators and internal auditors ask for chain-hash lookups, not JSON dumps.

## What is next (post-hackathon)

Full roadmap: [`docs/roadmap-post-hackathon.md`](./docs/roadmap-post-hackathon.md).

- **P0 (weeks 0–2):** Outcome Economics Engine — full triad (Work Ledger + Cost of Intelligence Ledger + Value Ledger). Mission State Fabric. Live-provider hardening for the three currently simulated adapters.
- **P1 (weeks 2–6):** Independent Outcome Evaluator, Modular Evaluation Factory, model-compute router extension (region + carbon-intensity), operator console replacing the demo UI.
- **P2 (weeks 6–12):** AIDR integration, Agent Passport, three named applications (BESS optimisation, VPP dispatch, DSO settlement), observability layer.
- **Commercial:** First OSaaS pilot signed by 30 Nov 2026 under the net-verified-gain settlement model. Pilot cap 15 %, max €1,000/day.

## Ecosystem

Mayleven → Ma11AI → Ronor → QMa11 → OSaaS. RONOR is the runtime layer. OSaaS is the settlement layer. The rest is the parent business.

## Team

Constantin Liviu NITA (Merlin) — solo builder. Product, strategy, architecture, and every commit.
Ma11AI, Mayleven Ltd (Company No. 17000500, England & Wales).

## Links

- **GitHub:** https://github.com/Constantin1968/RONOR- (public, branch `build-week`)
- **Live demo:** [Railway URL — added at deploy]
- **Demo video (2:57):** [YouTube unlisted URL — added after upload]
- **Codex session:** [session ID from `/feedback` — added at submission]

## Attribution

Built with **OpenAI GPT-5.6** (live BESS decision-loop proposer) and **OpenAI Codex** (orchestration and adapter scaffolding).

— Constantin Liviu NITA (Merlin) · Ma11AI · Mayleven Ecosystem
