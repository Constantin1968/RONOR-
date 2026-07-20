# RONOR — Model Exchange & Governance Spine for Energy Operations

_A governed runtime that turns frontier reasoning into auditable industrial work._

**Category:** Work & Productivity
**Submission:** OpenAI Build Week 2026
**Built by:** Constantin Liviu NITA (Merlin) · Ma11AI · Mayleven Ecosystem (Mayleven Ltd, Company No. 17000500, England & Wales)
**Attribution:** OpenAI GPT-5.6 (BESS decision-loop proposer) · OpenAI Codex (orchestration scaffolding)

---

## What this is

RONOR is a Node.js/TypeScript runtime that wires four things together into a single governed pipeline:

1. **A model exchange** — a registry of five engines behind a deterministic policy filter and a six-dimension router.
2. **A governance spine** — an MI9 Gate with six pre-execution checks and an R-Assurance layer with five post-execution checks.
3. **A hash-chained audit log** — SHA-256, SQLite-persisted, verifiable end-to-end from a CLI.
4. **A work + cost ledger** — every governed decision writes tokens, USD cost, latency, and verified confidence to a persistent store.

A realistic 20 MWh Romanian BESS scenario over OPCOM day-ahead and aFRR data runs through the same governance spine.

---

## Architecture (as shipped)

Canonical anchor: Strategic Brief Layer 0–7. See [`docs/ronor-architecture-reconciliation.md`](docs/ronor-architecture-reconciliation.md).

| Layer | Component | Files | Status |
| ----- | --------- | ----- | ------ |
| L0 Sovereign runtime | Node.js/TypeScript service, SQLite datastore | `src/index.ts`, `data/` | shipped |
| L1 Model Exchange | Registry · Policy P1–P8 · 6D Router · Engines · Work Ledger · Orchestrator | `src/model-exchange/*.ts` | shipped |
| L2 Data & Evidence | Audit chain (SHA-256), Work Ledger | `src/audit/hash-chain.ts`, `src/model-exchange/work-ledger.ts` | shipped |
| L3 Interface | Vanilla-JS operator console (three tabs, live audit-chain badge) | `web/` | shipped (demo tier) |
| L4 Governance (MI9) | Policy loader, 6-gate evaluator, YAML policy config | `src/governance/mi9-gate.ts`, `src/governance/policies.yaml` | shipped |
| L5 Applications | BESS 20 MWh Romania scenario | `src/decision-loop/*.ts` | shipped (single app) |
| L6 Observability | In-app timeline, `verify-chain` CLI, benchmark script | `web/`, `scripts/verify-chain.ts`, `scripts/benchmark.ts` | partial |
| L7 OSaaS | Cost of Intelligence Ledger primitive | `src/model-exchange/work-ledger.ts` | partial (Work Ledger only) |

Everything not in the table above is roadmap — see [`docs/roadmap-post-hackathon.md`](docs/roadmap-post-hackathon.md).

---

## The 6D router — EMS formula

Every eligible engine is scored on six dimensions:

```
Total  =  1.0 · Quality
        + 0.7 · Sovereignty
        + 0.6 · Evidence
        − 0.8 · Cost           (normalised against MAX_COST     = $0.05)
        − 0.5 · Latency        (normalised against MAX_LATENCY  = 8000 ms)
        − 0.6 · OperationalRisk
```

Policy filter runs before the router. Policy rules P1–P8 (`src/model-exchange/policy.ts`):

| Rule | Purpose |
| ---- | ------- |
| P1 | Confidentiality gate (public / internal / confidential / sovereign) |
| P2 | Jurisdiction pin (model-declared jurisdictions must match policy) |
| P3 | Deterministic first (`task_type=calculation` pins `ronor/deterministic-core`) |
| P4 | Provider allow-list |
| P5 | Max latency |
| P6 | Max cost |
| P7 | Required evidence level |
| P8 | Jurisdiction pin (request-side override) |

## The MI9 Gate

Six checks (`src/governance/mi9-gate.ts`). Verdicts: **allow · escalate · block**.

| Gate | Domain |
| ---- | ------ |
| 1 | Sovereignty (residency, jurisdiction) |
| 2 | Safety |
| 3 | Evidence quality |
| 4 | Exposure (blast radius) |
| 5 | Output quality |
| 6 | Jurisdiction (final pin) |

## R-Assurance

Five post-execution checks (`src/model-exchange/work-ledger.ts`, A1–A5): output completeness, format validity, evidence attribution, confidence coherence, and result reproducibility.

## Audit chain

Every request → verdict → result appended to a SHA-256 hash-chained SQLite log (`src/audit/hash-chain.ts`). Each record contains `seq`, `payloadHash`, `prevChainHash`, `chainHash`, `timestamp`. Verify end-to-end:

```bash
npx tsx scripts/verify-chain.ts
```

---

## Model registry

| Model | Sovereignty tier | Status | Cost / 1k out |
| ----- | ---------------- | ------ | ------------- |
| `openai/gpt-4.1` | 1 (public) | live | $0.008 |
| `anthropic/claude-sonnet-4` | 1 (public) | simulated | $0.015 |
| `mistral/mistral-large-2` | 2 (EU) | simulated | $0.006 |
| `qwen/qwen3-72b` | 3 (self-hosted-capable) | simulated | $0.002 |
| `ronor/deterministic-core` | 3 (local, sovereign) | live | $0.000 |

Simulated adapters return deterministic fake payloads with realistic latency and token counts so the router and ledger can be exercised without external API dependencies. Live-provider hardening for Anthropic, Mistral, and Qwen is a P0 roadmap item.

---

## HTTP API

Base: `http://localhost:3000/api/v1`

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/model-exchange/registry` | List all known models with capabilities and economics |
| `POST` | `/model-exchange/route` | Dry-run: policy filter + router scoring, no execution |
| `POST` | `/model-exchange/query` | Full pipeline: policy → router → MI9 → execute → assure → audit → ledger |
| `GET`  | `/model-exchange/ledger/cost` | Aggregated Cost Ledger view |
| `POST` | `/decisions` | Governed BESS decision endpoint |
| `GET`  | `/health` | Liveness + uptime |

Request body for `/route` and `/query`:

```json
{
  "query": "Should we sell 8 MWh on OPCOM DAM tomorrow given aFRR forecast?",
  "task_type": "reasoning",
  "confidentiality_level": "internal",
  "operator_id": "merlin"
}
```

`task_type` ∈ `reasoning · analysis · calculation · summary · routing`.
`confidentiality_level` ∈ `public · internal · confidential · sovereign`.

---

## Run it

Requires Node 20+.

```bash
git clone https://github.com/Constantin1968/RONOR-.git
cd RONOR-
git checkout build-week
npm install
npm run build

# OPENAI_API_KEY is recommended but not required.
# Without it, GPT-4.1 and GPT-5.6 fall back to deterministic engines.
export OPENAI_API_KEY=sk-...

npm start
```

Then open `http://localhost:3000/`.

Test suite:

```bash
npm test
```

Docker:

```bash
docker build -t ronor .
docker run -p 3000:3000 -e OPENAI_API_KEY=$OPENAI_API_KEY ronor
```

Railway deploy: `bash scripts/deploy.sh` (requires `railway login` first).

---

## What we changed during Build Week

Before Build Week, the repo had a working BESS decision loop, an MI9 Gate, and a hash-chained audit log. What Build Week added:

1. **Full Model Exchange layer** (`src/model-exchange/*.ts`) — registry, policy P1–P8, six-dimension router, five engine adapters, work + cost ledger, unified orchestrator.
2. **HTTP surface** for the exchange (`/registry`, `/route`, `/query`, `/ledger/cost`).
3. **Governance around the router, not after it** — MI9 evaluates every routed request before the engine call, not after.
4. **Operator console tabs** — Model Exchange registry table, 6D routing table with the winner highlighted, Cost Ledger JSON view.
5. **Two bug fixes worth naming** — `policies.yaml` now copies into `dist/` on build; sovereign/self-hosted models map to `eu` residency instead of the unrecognised `any`.
6. **Doc suite** — architecture reconciliation, post-hackathon roadmap, Devpost submission, video script.

---

## Docs

- [`docs/ronor-architecture-reconciliation.md`](docs/ronor-architecture-reconciliation.md) — five architectures reconciled onto Strategic Brief L0–7.
- [`docs/roadmap-post-hackathon.md`](docs/roadmap-post-hackathon.md) — P0–P3 queue, competitive landscape, OSaaS pilot plan, milestones through Q1 2027.
- [`docs/qma11-strategic-brief-18jul2026.md`](docs/qma11-strategic-brief-18jul2026.md) — canonical Layer 0–7 brief.
- [`docs/qma11-platform-brief-18jul2026.md`](docs/qma11-platform-brief-18jul2026.md) — 9-plane platform architecture (forward-look).
- [`docs/qma11-robotics-brief-18jul2026.md`](docs/qma11-robotics-brief-18jul2026.md) — Layer 0–6 physical AI runtime (R&D only).
- [`DEVPOST_SUBMISSION.md`](DEVPOST_SUBMISSION.md) — the Devpost submission text.
- [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md) — 2:57 demo script.

---

## OSaaS

Net verified gain settlement:

```
Gross value
  − inference / compute
  − tools / data
  − human review
  − security
  − amortisation
  − externalities
  = Net verified gain    ← only this is eligible for 50/50 profit-sharing
```

First pilot cap: 15 %, max €1,000/day. First pilot target: signed by 30 Nov 2026. See roadmap section 5.

Mayleven ecosystem: **Mayleven → Ma11AI → Ronor → QMa11 → OSaaS**.

---

## License

MIT.

— Constantin Liviu NITA (Merlin) · Ma11AI · Mayleven Ecosystem
