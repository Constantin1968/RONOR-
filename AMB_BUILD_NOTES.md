# RONOR Runtime Active — AMB Build Notes (internal working file)

Repo: `Constantin1968/RONOR-` · branch `build/runtime-active` · base tag `v0.4.0-core-active` (57f4379)
Working dir: `/home/ubuntu/ronor`
Git identity configured: AMB (Archeon Master the Best) <office@mayleven.com>
PAT embedded in remote URL (works, pushes verified).

## Baseline facts
- Pre-existing tests: **594 passing / 23 suites**. MUST stay green.
- After L1: **699 passing / 25 suites** (105 new).
- Commit ef8452a = L1 Model Exchange (pushed).

## Live provider environment (VERIFIED 2026-08-03)
`OPENAI_API_BASE=https://api.manus.im/api/llm-proxy/v1` — OpenAI-compatible multi-vendor gateway.
Allow-listed models ONLY (anything else → `{"error":"Unsupported model..."}`):
```
gpt-5-nano, gpt-5-mini, gpt-5, gpt-5.5,
claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7,
gemini-3-flash-preview, gemini-3.1-pro-preview
```
Pricing (USD per 1M in/out) confirmed from `/models`:
gpt-5-nano 0.05/0.40 · gpt-5-mini 0.25/2.00 · gpt-5 1.25/10.00 · gpt-5.5 5.00/30.00 ·
claude-haiku-4-5 1/5 · claude-sonnet-4-6 3/15 · claude-opus-4-6 5/25 · claude-opus-4-7 5/25 ·
gemini-3-flash-preview 0.5/3 · gemini-3.1-pro-preview 2/12

**DeepSeek and Perplexity are NOT on the gateway allow-list** and no vendor keys exist →
adapters are complete but report `key-absent`. This was reported to the Chairman and accepted.

### Critical wire facts (verified by live curl)
- GPT-5 family: MUST use `max_completion_tokens`. `max_tokens:50` → `finish_reason:"length"`, empty content.
- Gemini: MUST use `max_tokens`, and needs a GENEROUS budget (2000 was insufficient; 8192 works). `max_completion_tokens` → null content.
- Claude: `max_tokens` works; must be > `thinking.budget_tokens`.
- `response_format: json_schema` with `strict:true` works on gpt-5-mini and gemini-3-flash-preview;
  **claude-sonnet-4-6 IGNORED it via the gateway** and returned prose. → Workers must tolerate prose-wrapped JSON.
- Probe latencies observed: gpt-5-nano 1849ms, claude-haiku-4-5 883ms, gemini-3-flash 1138ms.

## Existing code contracts to reuse (do not break)
- `src/audit/hash-chain.ts`: `getDb()`, `append(AuditPayload) → AuditRecord`,
  `verifyChain()`, `listRecords(limit,offset)`, `getRecordsForDecision(id)`, `getHeadHash()`,
  `countRecords()`, `exportChain()`, `canonicalStringify()`. GENESIS_HASH = 64 zeros.
  `AuditPayload` requires: decisionId, decisionType, timestamp, context (DecisionContext),
  mi9Result (MI9Result), aiProposal{model,rationale,tokensUsed?,latencyMs?},
  outcome{action:'executed'|'held-for-cosign'|'escalated'|'blocked', ...}, metadata?
- `src/governance/mi9-gate.ts`: `loadPolicy()`, `evaluate(DecisionContext) → MI9Result`
  (verdict: 'allow'|'allow-with-cosign'|'escalate'|'block'; fields blockReason, humanCoSignRequired,
  produces exactly 9 findings).
- `src/planes/r-knowledge/index.ts`: `RKnowledgePlane.create(env?) → plane | null`
  (null unless `KNOWLEDGE_ENABLED === 'true'` EXACTLY). Methods: `init()`, `shutdown()`,
  `ingestDocument(raw)`, `ingestCorpusBatch(docs, opts)`, `query(raw)`, `compose(RagRequest)`,
  `health()`, `deploymentReadiness()`, `getDiagnostics()`, `getConfig()`, `getDegradation()`,
  `getStore()`, `getQuarantineRecords()`.
  - `RagRequest = { query, k?, maxClassification?, parentDocumentId? }`
  - `CorpusDocument = { sourceUri, content, classification, sovereigntyTier:1|2|3, sourceType?, parentDocumentId?, ingestedBy? }`
  - `KnowledgeRetrievalResponse = { ok, results[], reason, degradationLevel, storeId, embeddingProvider, queryNormalised, generatedAt }`
  - `RagOutcome = { ok, httpStatus:200|403|422|503, composedPrompt, results, citations, strippedCitations, complete, reason, degradationLevel }`
  - Knowledge env: KNOWLEDGE_ENABLED, KNOWLEDGE_VECTOR_STORE(sqlite|qdrant|none),
    KNOWLEDGE_EMBEDDING_PROVIDER(deterministic|openai|local|external), KNOWLEDGE_RAG_ENABLED,
    KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED, KNOWLEDGE_OPENAI_BASE_URL/API_KEY/MODEL,
    QDRANT_URL, QDRANT_API_KEY, QDRANT_COLLECTION_NAME, KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION,
    KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION, KNOWLEDGE_ENVIRONMENT_CLASS.
  - **BE-3 invariant**: `/health` must report EXACTLY 8 planes; knowledge reports separately.
    Do not add the knowledge plane to the `planes` array.
- `src/index.ts` mounts: `/api/v1` (createRouter(orchestrator)), `/api/v1` (createDecisionsRouter()),
  `/api/v1/model-exchange`, `/api/v1/sentinel`, conditional `/api/v1/knowledge`, static `web/`, `/health`.
- `src/model-exchange/*` (legacy) left UNTOUCHED — its tests pin exact behaviour.
- jest config: `testMatch: ['**/tests/**/*.test.ts']`, preset ts-jest, testTimeout 30s.
- tsconfig: commonjs, strict, rootDir ./src, excludes tests.

## New code layout (all under src/runtime/)
```
providers/  types.ts openai-compatible.ts gateway.ts openai.ts anthropic.ts
            google.ts deepseek.ts perplexity.ts deterministic.ts registry.ts
router/     catalogue.ts calibrator.ts policy.ts scoring.ts exchange.ts
ledgers/    schema.ts work-ledger.ts cost-ledger.ts
api/        auth.ts sanitize.ts classify.ts   (+ server.ts, middleware/ pending)
agents/     (pending)  tools/ (pending)  mission/ (pending)
```
Tests: `tests/runtime/providers.test.ts` (53), `tests/runtime/router.test.ts` (52).
Script: `scripts/probe-providers.ts` (live probe, works).

## Key design decisions already made
1. Provider contract NEVER throws; failures are typed `ProviderFailure` returns.
2. Credential resolution: native key → gateway → `key-absent` (never simulate).
   `OPENAI_API_KEY` is treated as GATEWAY, not native; native OpenAI needs `OPENAI_NATIVE_API_KEY`.
3. Max-token param mapping is table-driven in `inferFamilyConventions()`.
4. Calibrator: p50 over SUCCESSFUL calls only, bounded ring of 50, MIN_SAMPLES=3.
5. Policy adds **P0_CREDENTIAL_PRESENT** first; rejection reason names the emptying rule.
   P9_OPERATOR_PIN applied LAST so a pin cannot bypass governance.
6. Quality term discounted by observed success_rate.
7. Ledger tables: runtime_work, runtime_attempts, runtime_value, runtime_api_keys, runtime_missions
   — all in the SAME SQLite file as audit_chain (via `getDb()`).
8. Prompts are NEVER stored; only `prompt_digest` (sha256).
9. Auth: sha256-hashed secrets, timingSafeEqual, uniform 401, `INSECURE_DEFAULT_KEY` flagged in /health.
10. Sanitiser: flags-and-proceeds on suspicion, refuses only 3 hostile classes. Explicitly does
    NOT claim to prevent injection (documented in the module header).
11. Classifier is deterministic/local (no LLM call), caller's declared task_type always wins.

## Remaining phases
- L0 server (`api/server.ts`, middleware, routes) ← IN PROGRESS
- L2 mission state + knowledge bridge
- L3 agents: registry, passports, Researcher/Analyst/Evidence Curator, tools, synthesis
- L7 wire-up + audit integration
- Operator console (`web/console/`)
- docker-compose + Dockerfile + .env.example updates
- README + docs signed "Prepared by AMB"
- PR

Prepared by AMB.
