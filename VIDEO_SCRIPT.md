# RONOR — Build Week 2026 Demo Script

**Duration:** 2:57 · **Format:** 1920×1080, 30fps, H.264, ~10–12 Mbps · **Audio:** −14 LUFS
**Track:** Work & Productivity · **Product:** RONOR — Model Exchange & Governance Spine for Energy Operations
**Attribution:** OpenAI GPT-5.6 (BESS decision-loop proposer) · OpenAI Codex (backend + orchestration scaffolding)

---

## Cold open — 0:00–0:15  (title card + voice-over)

> **Voice-over:**
> "Energy operators need frontier reasoning. What they cannot afford is unaudited reasoning.
> RONOR is the model exchange and governance spine that closes that gap."

**Screen:** RONOR wordmark on Nexus background. Sub-line fades in: `Model Exchange & Governance Spine for Energy Operations`.

---

## Act 1 — The problem  ·  0:15–0:35

> **Voice-over:**
> "A trader running a 20-megawatt-hour battery on the Romanian day-ahead market needs a fast, sovereign answer to one question: sell now, or hold for the reserve market? Every provider gives a different answer at a different cost. None of them prove what happened."

**Screen:** Split screen. Left: OPCOM DAM price curve. Right: table of five raw model responses (openai/gpt-4.1, claude-sonnet-4, mistral-large-2, qwen3-72b, deterministic-core) with divergent recommendations and no audit trail.

---

## Act 2 — Model Exchange  ·  0:35–1:20

> **Voice-over:**
> "RONOR starts with a governed model exchange. A registry of five engines, tiered by sovereignty. A policy layer with eight rules — P1 through P8 — that filters out ineligible engines before scoring even begins. A six-dimension router that scores every survivor on quality, sovereignty, evidence, cost, latency, and operational risk."

**Screen:** UI — **Model Exchange** tab.
1. Click **Refresh registry** → 5-model table renders (sov=1..3, cost, latency).
2. Type the trader query. Click **Dry-run route**.
3. Routing table renders. Qwen wins at total 162.1. Camera zooms on the +Sov and +Ev columns.

> **Voice-over (over the zoom):**
> "For an internal reasoning query, the sovereignty and evidence weights pull Qwen ahead of GPT-4.1 — despite lower raw quality. That is a routing decision, not a preference."

---

## Act 3 — The Governance Spine  ·  1:20–2:10

> **Voice-over:**
> "The moment the router hands off, the governance spine takes over. MI9 Gate runs six checks: sovereignty, safety, evidence, exposure, quality, jurisdiction. Its verdict is one of three: allow, escalate, block. Then R-Assurance runs five more checks on the output. Then, and only then, the answer is committed."

**Screen:** Switch input to `task_type=calculation`, query `15.7 * (240 - 85) / 3`. Click **Run governed query**.
1. Routing table repopulates. Policy P3 pins `ronor/deterministic-core` at total 228.7 — annotate with the 📌 marker.
2. Result JSON drops in.
3. Camera cuts through the JSON fields in sequence:
   - `mi9_verdict: escalate` (evidence gate)
   - `assurance.verified_confidence: 100`
   - `audit_seq: 7`
   - `audit_chain_hash: 709573e485f0…`
   - `answer_preview: "Deterministic evaluation: 15.7 * (240 - 85) / 3 = 811.166666666666. Computed locally by RONOR Deterministic Core — exact, reproducible, zero marginal cost, no data left the sovereign boundary."`

> **Voice-over (over the JSON reveal):**
> "MI9 escalated on evidence, but did not block. The deterministic engine executed. R-Assurance verified at one hundred percent. The result was appended to an SHA-256 hash-chained audit log at sequence seven. Every prior decision remains cryptographically anchored to every subsequent one."

---

## Act 4 — Verifiable, not just logged  ·  2:10–2:35

> **Voice-over:**
> "Any operator, any auditor, any regulator can walk the chain from genesis to the current head and verify it end-to-end."

**Screen:** Terminal window. Run:
```
npx tsx scripts/verify-chain.ts
```
Output:
```
✓ 7 / 7 records verified
✓ chain head: 709573e485f0…
✓ no gaps · no forks · no tampering
```

> **Voice-over:**
> "This is the difference between a log and an audit. RONOR ships both."

---

## Act 5 — The economics  ·  2:35–2:50

> **Voice-over:**
> "Every governed decision writes to the Work Ledger. Tokens, cost, latency, simulation flag, verified confidence. Aggregated by model and task type. That feed is the raw input for OSaaS — the net-verified-gain accounting model where the operator and the runtime share only what was actually earned."

**Screen:** UI — **Cost Ledger** tab. JSON view scrolls: 7 requests, split across qwen/qwen3-72b and ronor/deterministic-core, cost of intelligence exposed to the fourth decimal.

---

## Close — 2:50–2:57

> **Voice-over:**
> "RONOR — Model Exchange and Governance Spine for Energy Operations. Ma11AI, Mayleven Ecosystem."

**Screen:** End card. Wordmark. URLs: repo, live demo, docs. Small attribution line: `Built with OpenAI GPT-5.6 + Codex.`

---

## Delivery notes

- **Screens 2 (routing), 3 (JSON reveal), 5 (ledger)** are the load-bearing frames — do not cut them short.
- **Recording order:** Act 3 first (needs prior audit history to hit seq=7). Then Act 5 (ledger already has 7 rows). Then Act 2. Then wraps.
- **Pacing:** Voice-over is written for 155–160 wpm delivery. Voice-over word count ≈ 328 → ≈ 2:03 of speech + ≈ 54 seconds of silent screen action (routing table zoom, JSON reveal, verify-chain terminal, ledger scroll).
- **Audio bed:** Ambient synth pad −24 LUFS under voice; no music sting at the close.
