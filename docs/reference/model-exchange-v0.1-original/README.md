# RONOR Model Exchange v0.1

**A Sovereign Generative Intelligence Runtime** — provider-neutral, model-portable, evidence-governed.

Built for the **OpenAI Build Week Hackathon (July 2026)**.

## The Problem

National governments and critical enterprises are rapidly becoming dependent on single-provider generative AI (e.g., OpenAI, Anthropic). This creates unacceptable strategic risks:
- **Operational:** Single points of failure, vendor lock-in.
- **Economic:** Unpredictable token pricing and margin extraction.
- **Geopolitical:** Data sovereignty violations, export controls, and foreign jurisdiction leverage.

## The Solution: RONOR

RONOR is not a model. It is an **orchestration runtime** that sits between the user and the models. It abstracts the intelligence supply chain into seven operational planes:

1. **Access Plane:** A Unified Request API (`POST /api/query`). One contract for every model, agent, tool, and task.
2. **Policy Plane:** Deterministic governance. Rules enforce confidentiality, jurisdiction, budgets, and provider allow-lists *before* routing.
3. **Routing Plane:** The Dynamic Router scores every eligible engine based on Quality, Cost, Latency, Operational Risk, Sovereignty, and Evidence Reliability. It automatically selects the lowest total-cost configuration.
4. **Execution Plane:** Engine adapters (OpenAI, Anthropic, Deterministic Core) with automatic fallback if the primary engine fails.
5. **Assurance Plane:** R-Assurance verifies the output, calibrates confidence, and ensures source attribution.
6. **Economic Plane:** The Cost Ledger tracks per-token, per-task, and per-provider accounting in real time.
7. **Evidence Plane:** The Trace Ledger creates an append-only, hash-chained audit record of every decision and result.

## How it uses OpenAI

RONOR uses the OpenAI API (model `gpt-4.1`, JSON mode) as its primary high-capability reasoning engine. When a request hits the Unified API, the router evaluates OpenAI against other engines (like Anthropic or a local Deterministic Core). If OpenAI offers the best score for the given constraints (e.g., high reasoning requirement, public confidentiality), RONOR executes a real API call to OpenAI, parses the structured response, verifies it via R-Assurance, and logs the exact token cost to the ledger.

## Architecture

- **Backend:** Node.js / Express (in-memory ledgers for v0.1 prototype)
- **Frontend:** React 18 + Vite (Operator Dashboard)
- **Engines:** OpenAI (Live via API), Anthropic (Simulated for demo), Deterministic Core (Live local execution)

## Setup & Run

### Prerequisites
- Node.js 18+
- An OpenAI API key

### Installation
```bash
npm install
npm run build
```

### Run the Runtime
```bash
export OPENAI_API_KEY="sk-..."
npm start
```
The dashboard will be available at `http://localhost:3000`.

## License
MIT
