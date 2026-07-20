# RONOR — Devpost Submission
_OpenAI Build Week 2026 · Work & Productivity_

## Project name
**RONOR — Model Exchange & Governance Spine for Energy Operations**

## Category
**Work & Productivity** (industrial operator workflow — energy trading, BESS dispatch, DSO settlement)

## One-line pitch
A sovereign model exchange plus a hash-chained governance spine that turns frontier reasoning into auditable industrial work.

---

## Elevator pitch (150 words)

Energy operators cannot ship AI they cannot audit. RONOR is a governed runtime for that constraint. A registry of five engines — GPT-4.1, Claude Sonnet 4, Mistral Large 2, Qwen3-72B, and a local Deterministic Core — sits behind a six-dimension router that scores every eligible engine on quality, sovereignty, evidence, cost, latency, and operational risk. Eight policy rules (P1–P8) filter the registry before scoring begins. Every request then passes through the MI9 Gate — six pre-execution checks with verdicts of allow, escalate, or block — and, on the output side, five R-Assurance checks (A1–A5). Every decision, verdict, cost, and result is appended to a SHA-256 hash-chained SQLite audit log that any operator can verify end-to-end with a single CLI command. A realistic 20 MWh Romanian BESS scenario over OPCOM day-ahead and aFRR data is wired end-to-end. This is Work & Productivity in the strictest sense: the productivity of an operator who can prove, on demand, what the AI actually did.

---

## Inspiration

Two forces made this necessary. First, energy operators in the EU face converging regulatory pressure — REMIT II, the EU AI Act general-purpose obligations, and sector-specific audit requirements — all of which assume the operator can explain and reproduce every automated decision. Second, model providers have converged on similar frontier capabilities but diverged wildly on cost, latency, jurisdiction, and evidence quality. Operators need to pick per request, not per contract. Every single-provider AI stack fails one of those tests. RONOR is designed to fail neither.

## What it does

- **Model Exchange.** Five engines behind one Unified Request API. Registry, deterministic policy filter (P1–P8), six-dimension router with a published scoring formula: `Quality + Sovereignty + Evidence − Cost − Latency − Risk`, then engine execution with automatic fallback to the next-ranked engine on failure.
- **Governance Spine.** MI9 Gate runs six pre-execution checks (sovereignty, safety, evidence, exposure, quality, jurisdiction), and returns `allow`, `escalate`, or `block`. R-Assurance runs five post-execution checks (A1–A5) on the answer. Both are wired around the router, not bolted on.
- **Audit chain.** Every request, verdict, and result is appended to an SHA-256 hash-chained SQLite log. A CLI (`scripts/verify-chain.ts`) walks the chain end-to-end and reports any gap, fork, or tamper.
- **Work Ledger + Cost Ledger.** Every governed query writes tokens, USD cost, latency, simulation flag, and verified confidence. Aggregations by model and task type. This is the raw feed for the OSaaS net-verified-gain settlement model.
- **BESS decision loop.** A realistic 20 MWh Romania scenario over OPCOM DAM and aFRR data, wired through the same governance spine.
- **Operator UI.** Three tabs (BESS Decision Loop, Model Exchange, Cost Ledger) with a live audit-chain badge in the header.

## How we built it

- **Runtime.** Node.js + TypeScript. Express HTTP layer. SQLite (via `better-sqlite3`) for both the audit chain and the Work Ledger.
- **Model Exchange layer.** Five files under `src/model-exchange/`: `registry.ts`, `policy.ts`, `router.ts`, `engines.ts`, `work-ledger.ts`, plus the unified `orchestrator.ts` that wires the full pipeline.
- **Governance Spine.** `src/governance/mi9-gate.ts` + `governance/policies.yaml` for MI9. `src/audit/hash-chain.ts` for the SHA-256 chain.
- **BESS.** `src/decision-loop/bess-scenario.ts` + `gpt-56-adapter.ts` + `orchestrator.ts`. The proposer is GPT-5.6 with a deterministic fallback.
- **UI.** Vanilla JavaScript. Nexus palette. Satoshi (Fontshare) for headings, JetBrains Mono for structured data.
- **Ops.** Dockerfile + railway.json + `scripts/deploy.sh` for the Railway target. Jest for the test suite (governance, audit, e2e).
- **AI tooling.** OpenAI Codex generated and refined the orchestration scaffolding and adapter interfaces. GPT-5.6 is the live BESS proposer.

## OpenAI usage

- **GPT-4.1** is the live high-capability reasoning engine in the model exchange. It is invoked only after policy filtering and router scoring. Its response passes through R-Assurance and lands in the audit chain with token usage, USD cost, latency, and the full routing rationale.
- **GPT-5.6** is the live BESS decision-loop proposer. It emits a structured recommendation which the MI9 Gate then verdicts.
- **Codex** produced the initial `orchestrator.ts` pipeline, the router scoring implementation, the audit chain append/verify path, and the operator UI scaffolding. Every generated file was reviewed, tested, and edited before commit.

## Challenges we ran into

- **Two parallel codebases.** A prior submission (`RONOR_Model_Exchange_v0.1_Final_Verified`) shipped a Node/Express + React/Vite Model Exchange with an in-memory ledger. The Build Week repo already had the governance spine, hash-chain audit, and BESS scenario. Reconciling them without duplicating logic required a triage matrix and a full port of the exchange logic into TypeScript so it could share the audit chain, work ledger, and MI9 Gate with the rest of the stack.
- **Policy false-positive on residency.** MI9 Gate blocked deterministic-core queries because the model's declared jurisdictions were `["sovereign"]` — a value the default policy did not recognise as an EU zone. Fixed in the orchestrator by mapping `sovereign` and `self-hosted` to `eu` (Ronor is Romania/UK-based).
- **Runtime asset copying.** `policies.yaml` was not copied into `dist/` on build. Fixed in the `postbuild` script.

## Accomplishments we are proud of

- The full pipeline — Policy → Router → MI9 → Execute → R-Assurance → Audit → Work Ledger — is a single `runUnifiedQuery` call. No orchestration is deferred to the UI or the caller.
- Every decision the operator sees on screen is anchored to a chain hash they can verify from the command line.
- Deterministic-core runs at 1 ms with zero cost and 100 % verified confidence, so the router genuinely picks the cheapest correct answer, not the most impressive one.

## What we learned

- Governance should sit around the router, not after it. Placing MI9 after execution would let ungoverned inference occur before rejection.
- Sovereignty is a router dimension, not a filter. Treating it as a scoring term (weight 0.7) makes it composable with cost and latency, rather than binary.
- An audit chain is a product feature. Regulators and internal auditors ask for chain-hash lookups, not JSON dumps.

## What is next (post-hackathon)

Full roadmap: [`docs/roadmap-post-hackathon.md`](./docs/roadmap-post-hackathon.md).

- **P0 (weeks 0–2):** Outcome Economics Engine — full triad (Work + Cost of Intelligence + Value ledgers). Mission State Fabric. Live-provider hardening for the three currently simulated adapters.
- **P1 (weeks 2–6):** Independent Outcome Evaluator, Modular Evaluation Factory, model-compute router extension (region + carbon-intensity), operator console replacing the demo UI.
- **P2 (weeks 6–12):** AIDR integration, Agent Passport, three named applications (BESS optimisation, VPP dispatch, DSO settlement), observability layer.
- **Commercial:** First OSaaS pilot signed by 30 Nov 2026 under the net-verified-gain settlement model (pilot cap 15 %, max €1,000/day).

## Ecosystem

Mayleven → Ma11AI → Ronor → QMa11 → OSaaS. RONOR is the runtime layer. OSaaS is the settlement layer. The rest is the parent business.

## Team

Constantin Liviu NITA (Merlin) — product, strategy, architecture. Ma11AI, Mayleven Ltd (Company No. 17000500, England & Wales).

## Links

- **GitHub:** https://github.com/Constantin1968/RONOR- (branch `build-week`)
- **Live demo:** [Railway URL to be added at deploy]
- **Video (2:57):** [YouTube unlisted URL to be added]
- **Codex session:** [session ID to be added]

## Attribution

Built with **OpenAI GPT-5.6** (BESS decision-loop proposer) and **OpenAI Codex** (backend and orchestration scaffolding).

— Constantin Liviu NITA (Merlin) · Ma11AI · Mayleven Ecosystem
