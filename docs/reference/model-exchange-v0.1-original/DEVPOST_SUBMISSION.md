# RONOR Model Exchange — Devpost Submission

## Category
Developer Tools

## Elevator pitch
RONOR is a sovereign intelligence runtime that routes each request to the most appropriate eligible engine according to policy, quality, cost, latency, operational risk, sovereignty and evidence reliability—then records the decision in a hash-chained audit ledger.

## Inspiration
Governments and critical enterprises increasingly depend on single-provider AI. This creates vendor lock-in, opaque inference economics, jurisdictional exposure and operational concentration risk. RONOR introduces a neutral execution layer between applications and models.

## What it does
- Exposes one Unified Request API (`POST /api/query`).
- Enforces confidentiality, budget, latency, evidence and provider policies before execution.
- Scores eligible engines transparently.
- Routes reasoning workloads to OpenAI GPT-4.1 when it wins the configured policy.
- Routes exact calculations to a local Deterministic Core.
- Performs automatic fallback when the preferred engine cannot complete the task.
- Produces assurance metadata, per-token cost accounting and a SHA-256 hash-chained trace.

## How we built it
RONOR uses a Node.js/Express runtime and a React/Vite operator dashboard. OpenAI is integrated through a server-side adapter. The platform includes a Model Registry, deterministic Policy Engine, Dynamic Router, Execution adapters, R-Assurance, Cost Ledger and Trace Ledger. Codex was used to generate and refine the backend orchestration logic and dashboard components.

## OpenAI usage
OpenAI GPT-4.1 is the live high-capability reasoning engine. The router invokes it only after policy filtering and scoring. Structured output is then passed through R-Assurance and recorded with token usage, USD cost, latency and routing rationale.

## What is next
- Production adapters for additional providers and self-hosted models.
- Persistent ledgers and signed audit exports.
- Continuumpedia as the first native intelligence application on RONOR.
- RONOR Intelligence Credits: a provider-neutral accounting layer for external inference capacity and future Mayleven/Ma11AI-owned compute powered by owned and managed energy assets.

## Links
- Live demo: [ADD URL]
- GitHub: [ADD URL]
- Video: [ADD URL]
- Codex Session ID: [ADD URL]
