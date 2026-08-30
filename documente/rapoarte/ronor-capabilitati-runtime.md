# RONOR — Inventar de capabilități, runtime generația a doua

Obiect al auditului: `/home/user/workspace/ronor/src/runtime/` (70 fișiere TypeScript, 13.114 linii).
Metodă: citire directă a codului sursă. Fiecare afirmație este trasabilă la fișier și interval de linii.
Referințele de forma `providers/types.ts:265` sunt relative la `src/runtime/`.

---

## 0. Concluzia de sinteză

| Subsistem | Verdict | Bază |
|---|---|---|
| `providers/` (13 fișiere) | **Real, integral.** Nicio simulare. | `grep -rn "simulated: true\|Math.random()" src/runtime` → 0 rezultate |
| `router/` (6 fișiere) | Real. 6 dimensiuni de scoring, 10+ familii de reguli de politică. | `router/scoring.ts:32-39`, `router/policy.ts:113-303` |
| `agents/` (5 fișiere) | Real. Abstracție de „lucrător digital" prin Agent Passports. | `agents/registry.ts:39-162` |
| `api/` (8 fișiere) | Real. Autentificare pe cheie hash-uită, pipeline în 9 etape. | `api/auth.ts:46-56`, `api/pipeline.ts:6-7` |
| `ledgers/` (3 fișiere) | Real, SQLite. Există un **Value Ledger**, dar **nu** un „net verified gain". | `ledgers/schema.ts:103-122` |
| `automation/` (31 fișiere) | Cod complet, **dezactivat implicit** (adaptoare HTTP externe neconfigurate). | `automation/adapter-registry.ts:34,49-51` |
| `mission/store.ts` | Real. Event sourcing cu lanț hash și concurență optimistă. | `mission/store.ts:267-324` |
| `management/` | Real, dar declarativ (registru + reguli de delegare). | `management/registry.ts:34-59` |
| `knowledge/bridge.ts` | Real, delegă către `planes/r-knowledge` (1.436 linii). | `knowledge/bridge.ts:34` |

---

## 1. `providers/` — adaptoare de model

### 1.1 Contractul comun

`providers/types.ts` (275 l) definește `ProviderAdapter`. `ProviderId` = openai | anthropic | google | deepseek | perplexity | kimi | xai | ollama | deterministic (`types.ts:32-41`). `TransportMode` = native | gateway | local (`l.53`). `CredentialState` = live-native | live-gateway | live-local | key-absent (`l.55-63`). Zece clase de eșec (`l.65-75`). Apelul HTTP real este centralizat în `fetchWithTimeout`, care folosește `fetch(url, { ...init, signal })` la **`types.ts:265`**, cu `DEFAULT_TIMEOUT_MS = 120_000` (`l.275`). Comentariul de la `l.146-151` afirmă explicit că `simulated` este „Always false in Runtime Active"; estimarea de tokeni este caractere/4 (`l.252`).

### 1.2 Tabel: real vs. simulat, cheie de mediu, punctul de apel

| Fișier | Apel HTTP real | Linia apelului | Cheie (env) | Bază URL |
|---|---|---|---|---|
| `openai.ts` (94 l) | Da, via `openai-compatible` | `openai-compatible.ts:194-209` | `OPENAI_NATIVE_API_KEY` | `OPENAI_BASE_URL` \|\| `https://api.openai.com/v1` (`l.62`) |
| `anthropic.ts` (273 l) | **Da — implementare nativă proprie** | `anthropic.ts:159-171` (`${baseUrl}/messages`) | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` \|\| `https://api.anthropic.com/v1` (`l.112`) |
| `google.ts` (299 l) | Da, nativ | `google.ts:170-171` (`/models/${model}:generateContent`) | `GEMINI_API_KEY` | `GEMINI_BASE_URL` \|\| `.../v1beta` (`l.133-134`) |
| `xai.ts` (54 l) | Da | `openai-compatible.ts:194-209` | `XAI_API_KEY` | `XAI_BASE_URL` \|\| `https://api.x.ai/v1` (`l.36`) |
| `deepseek.ts` (116 l) | Da | idem | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` \|\| `https://api.deepseek.com/v1` (`l.83`) |
| `kimi.ts` (72 l) | Da | idem | `KIMI_API_KEY` | `KIMI_API_BASE` \|\| `https://api.moonshot.ai/v1` (`l.56`) |
| `perplexity.ts` (124 l) | Da | idem | `PERPLEXITY_API_KEY` | `PERPLEXITY_BASE_URL` \|\| `https://api.perplexity.ai` (`l.91`) |
| `ollama.ts` (48 l) | **Da** — `fetch(\`${base}/api/chat\`)` | `ollama.ts:38` | fără cheie; poartă `OLLAMA_ENABLED === 'true'` (`l.25`) | `OLLAMA_CONTABO_BASE_URL` / `OLLAMA_LOCAL_BASE_URL` / `http://127.0.0.1:11434` (`l.8-10`) |
| `deterministic.ts` (339 l) | N/A — calcul local | parser shunting-yard, fără `eval` | — | `credentialState()` → `'live-local'` (`l.292-293`) |
| `openai-compatible.ts` (381 l) | **Transport partajat** `POST ${baseUrl}/chat/completions`, `Authorization: Bearer` | `l.194-209` | de la apelant | de la apelant |
| `gateway.ts` (105 l) | Rezolvă ruta native → gateway → refuz | `l.58-59` | `RONOR_GATEWAY_API_KEY` \|\| `OPENAI_API_KEY` | `RONOR_GATEWAY_BASE_URL` \|\| `OPENAI_API_BASE` |
| `registry.ts` (99 l) | Map îngheţat cu 9 adaptoare (`l.31-41`) | — | — | stare de credenţial calculată la cerere, niciodată memoizată |

Observaţii de detaliu:

- `gateway.ts:80-88` fixează maparea provider → variabilă nativă; `OPENAI_API_KEY` este **deliberat exclus** din setul nativ (justificare la `l.90-98`) — este cheie de gateway, nu de acces direct.
- Lista de modele permise pe gateway: `DEFAULT_GATEWAY_MODELS` (`gateway.ts:41-52`), suprascriabilă cu `RONOR_GATEWAY_MODELS` (`l.62`).
- `openai-compatible.ts:72-93` (`inferFamilyConventions`) adaptează parametrii per familie: `gpt-/o1/o3/o4` → `max_completion_tokens` + effort OpenAI; `claude` → `max_tokens` + buget de gândire Anthropic; `gemini` → effort Gemini. Fracţiile de buget de gândire: high 0,5 / medium 0,3 / low 0,15, minim 1024 (`l.101-109`).
- Detecţie de completare vidă cu `finish_reason=length` (`l.286-305`); normalizarea citărilor, plafon 12 (`l.344-380`).
- `anthropic.ts:225-229` păstrează exclusiv blocurile `type === 'text'`; antetele sunt `x-api-key` + `anthropic-version` (implicit `'2023-06-01'`, `l.56`).
- `ollama.ts:3` declară 11 modele locale (inclusiv `qwen2.5:72b-instruct-q4_K_M`, `deepseek-r1:70b-llama-distill-q4_K_M`, `bge-m3:latest`), jurisdicţii `['LOCAL','RO']` (`l.22`).

### 1.3 Comparaţie cu modulul vechi `src/model-exchange/engines.ts`

| Aspect | `src/model-exchange/engines.ts` (329 l) | `src/runtime/providers/` |
|---|---|---|
| Simulare | `executeSimulatedProvider` cu `await sleep(400 + Math.round(Math.random() * 400))` (`l.131-158`, întârziere la `l.137`), text `[SIMULATED — ... adapter not configured...]` (`l.143`), `simulated: true` (`l.156`) | inexistentă |
| Mistral / Qwen | `executeMistral` (`l.230-233`) şi `executeQwen` (`l.235-237`) simulează **întotdeauna** | Qwen servit real prin Ollama; Mistral neinclus |
| Anthropic | `executeAnthropic` (`l.160`) simulează în absenţa `ANTHROPIC_API_KEY` (`l.162`) | implementare nativă reală (`anthropic.ts:159-171`) |

Cablare: `src/index.ts:50` importă `createRuntimeRouter` din `./runtime/api/routes`; montarea are loc la `/api/runtime` cu `provenanceMiddleware` (`src/index.ts:245-246`). **Modulul vechi rămâne montat** la `/api/v1` şi `/api/v1/model-exchange` (`index.ts:249-251`). Concluzie: runtime-ul **înlocuiește funcţional** adaptoarele simulate, dar nu le elimină din proces — coexistenţa este o datorie tehnică cu risc reputaţional (un apelant pe ruta legacy poate primi text simulat).

---

## 2. `router/` — bursa de modele

### 2.1 Scoring — 6 dimensiuni

`router/scoring.ts:4` defineşte formula: `Score = +Calitate − Cost − Latenţă − RiscOperaţional + Suveranitate + Evidenţă`. Ponderi (`RUNTIME_WEIGHTS`, `l.32-39`): calitate 1,0; cost 0,8; latenţă 0,5; risc operaţional 0,6; suveranitate 0,7; evidenţă 0,6. Normalizatori: `MAX_REASONABLE_COST_USD = 0,05`, `MAX_REASONABLE_LATENCY_MS = 15_000` (`l.42-43`). Calitatea efectivă este ponderată de telemetrie: `quality_score * telemetry.successRate` (`l.80`); termenul de suveranitate este `(level/3)*100` (`l.87`). Departajare: total → cost → latenţă → id (`l.135-144`), plus pin determinist `P3_DETERMINISTIC_FIRST` (`l.146-155`).

### 2.2 Politici — P0…P9, aplicate înainte de scoring

`router/policy.ts` (330 l). Fiecare regulă înregistrează seturile excluse și admise.

| Regulă | Linii | Ce impune |
|---|---|---|
| P0_CREDENTIAL_PRESENT | 113-122 | doar provideri invocabili (`invocableProviders()`) |
| P1_SOVEREIGN_ONLY / P1_RESTRICTED_ATTESTABLE | 124-144 | nivel suveranitate ≥ 3, respectiv ≥ 1 |
| P2_CAPABILITY_MATCH | 146-162 | potrivire capabilitate; sarcinile exacte (calculation/validation/lookup, `l.62`) admit `reasoning` ca escaladare |
| P3_DETERMINISTIC_FIRST | 164-175 | motorul determinist are prioritate pe aritmetică |
| P4_PROVIDER_ALLOWLIST / DENYLIST | 177-201 | liste explicite de operator |
| P5_LATENCY_CEILING | 203-218 | plafon faţă de p50 **calibrat**, nu faţă de valoarea de catalog |
| P6_COST_CEILING | 220-230 | plafon de cost estimat |
| P7_EVIDENCE_FLOOR | 232-245 | prag minim de fiabilitate a evidenţei |
| P8_JURISDICTION_EU / SOVEREIGN / US | 247-277 | filtrare jurisdicţională (setul UE la `l.65-69`, include RO) |
| P2S_SEARCH_REQUIRED | 279-288 | cere provider cu augmentare prin căutare |
| P9_OPERATOR_PIN | 290-303 | aplicat ultimul; **nu poate lărgi** setul admis |

Estimarea de cost: `inputTokens = caractere/4 + 600`, output aşteptat implicit 900 (`l.80-90`). `buildRejectionReason` (`l.324-330`) numeşte regula care a golit setul — respingerile sunt explicabile.

### 2.3 Catalog

`router/catalogue.ts` (457 l): **24 de intrări**, cu câmpurile id, provider, vendorModel, displayName, capabilities, `input_cost_per_1m`, `output_cost_per_1m`, `latency_seed_ms`, jurisdictions, `sovereignty_level` (0-3), `quality_score`, `evidence_reliability`, `operational_risk`, `context_window`, `max_output_tokens`, `search_augmented`. Distribuţie: 9 intrări Ollama (`l.68-116`), 4 OpenAI (`l.123-177`), 3 Anthropic (`l.197-233`), 4 Google (`l.253-271, 408`), 2 DeepSeek (`l.291-309`), 2 Perplexity (`l.329-350`), 1 Kimi (`l.370`), 1 xAI (`l.390`), 1 determinist (`l.428`). Cele 12 valori `RuntimeCapability`: reasoning, generation, analysis, summarization, extraction, calculation, validation, lookup, search, synthesis, verification, decomposition.

### 2.4 Calibrator

`router/calibrator.ts` (126 l) calibrează **latenţa p50 observată** şi **rata de succes** per model — nu costul şi nu calitatea. Fereastră glisantă `WINDOW_SIZE = 50`, `MIN_SAMPLES = 3` (`l.32-34`), inel în proces (`l.42`). p50 se calculează doar pe apelurile reuşite (`l.86-89`); rata de succes este 1 în absenţa eşantioanelor (`l.79`). `seedFromLedger` (`l.116-126`) preîncarcă, best-effort, din Work Ledger — deci calibrarea supravieţuieşte repornirii.

### 2.5 „Model Cabinet"

`router/model-cabinet.ts` (75 l) **nu** este un router de execuţie, ci un **tablou declarativ rol → model** cu 18 rute (`l.45-64`). Câmpuri: role, model, location (laptop / contabo / contabo-candidate / alibaba-cloud / cloud / self-hosted-candidate), mode (interactive / batch / embedding / cloud), status (available / credential-gated / install-required / deferred), rationale, modalities, `budget_class` 0-3, privacy (sovereign | cloud), `min_ram_gb`. Roluri: rapid-private, qwen-laptop-upgrade, coding-local, memory, analysis-baseline, qwen-moe-primary, qwen-dense-candidate, qwen-agentic-code-local, qwen-frontier, qwen-agentic-code-cloud, qwen-speech, qwen-omni, qwen-image, local-verification, deep-reasoning, frontier-escalation, multimodal-agentic, managed-executor (deferred). Modelele instalate se citesc din `RONOR_INSTALLED_MODELS` (`l.28`); Qwen în cloud este condiţionat de `DASHSCOPE_API_KEY` (`l.43`). `selectModelRoutes` (`l.67-75`) filtrează pe disponibilitate, modalitate, buget, suveranitate şi interactivitate.

### 2.6 Execuţie

`router/exchange.ts` (289 l): `executeExchange` = politică → ordonare → execuţie → fallback → contabilizare. `maxAttempts` implicit 3 (`l.178`). Telemetria se înregistrează pentru ambele rezultate (`recordSample`, `l.208`). `total_cost_usd` însumează **toate** încercările (`l.215, 244`) — costul risipit este vizibil. Un refuz de conţinut opreşte lanţul (`l.260-274`). Stări: completed, completed-after-fallback, rejected-policy, all-providers-failed, content-refused (`l.62-67`). Există şi `routeOnly` (`l.117`) şi o cale `dryRun` (`l.167-176`). `maxOutputTokens` este limitat la `entry.max_output_tokens` (`l.199`).

---

## 3. `agents/` — abstracţia de lucrător digital

**Da, aceasta este o abstracţie de „lucrător digital", nu un simplu wrapper de prompt.** Argumentul: fiecare lucrător are un **paşaport** cu mandat, plafon de confidenţialitate, listă albă de unelte şi prag de evidenţă, iar aplicarea listei albe este centralizată în afara modelului.

### 3.1 Paşapoarte

`agents/registry.ts` (220 l). `AgentPassport` (`l.39-62`): agent_id, name, version, mandate, capabilities, allowed_tools, max_confidentiality, preferred_models, router_task_type, required_evidence_level, reasoning_effort, max_output_tokens, may_lower_confidence, status.

| Lucrător | Unelte permise | Conf. max | Tip sarcină router | Prag evidenţă | Efort / tokeni | Poate reduce încrederea |
|---|---|---|---|---|---|---|
| `researcher` (`l.64+`) | knowledge.search, web.fetch, calc.exact | restricted | extraction (motivaţie la `l.84-101`) | 60 | low / 4096 | nu |
| `analyst` | calc.exact, knowledge.search (**fără** web.fetch) | sovereign | analysis | — | high / 8192 | nu |
| `evidence-curator` | knowledge.search, web.fetch, calc.exact | restricted | verification | 70 | medium / 4096 | **da** — singurul |

`CONFIDENTIALITY_RANK`: public 0, internal 1, restricted 2, sovereign 3 (`l.204-209`). `clonePassport` copiază adânc tablourile (`l.173-180`), deci un paşaport nu poate fi mutat la runtime.

### 3.2 Unelte

`agents/tools.ts` (407 l) — patru unelte:

| Uneltă | Linii | Efecte secundare | Constrângeri |
|---|---|---|---|
| `calc.exact` | 100-125 | nu | delegă către `computeExactly` |
| `knowledge.search` | 131+ | nu | marchează ieşirea drept `untrustedOutput` |
| `web.fetch` | 232-292 | nu | timeout 20 s, gardă SSRF, refuz pe content-type non-text, plafon 40.000 caractere, **refuz total când confidenţialitatea este `sovereign`** (`l.245-252`) |
| `knowledge.ingest` | 316-355 | **da — singura** | mapează confidenţialitatea la clasificare RESTRICTED/CONFIDENTIAL/INTERNAL şi `sovereigntyTier` 3/2 |

Izolarea prompt-injection: `wrapUntrusted` (`l.70-80`) încadrează ieşirea uneltei într-un delimitator `<RONOR-TOOL-DATA id="...">` cu **nonce aleator de 9 octeţi per invocare** — un atacator nu poate ghici delimitatorul de închidere. `isFetchableUrl` (`l.213-229`) blochează schemele non-http(s) şi `BLOCKED_HOST_PATTERNS` (adrese private, loopback, `.internal`, `.local`, `^metadata.`). `invokeTool` (`l.386-407`) impune lista albă din paşaport central şi nu aruncă niciodată excepţii.

### 3.3 Execuţia lucrătorului

`agents/workers.ts` (404 l). `runWorker` (`l.140`) verifică plafonul de confidenţialitate al paşaportului (`l.168-184`), rulează faza de unelte (`l.186-199`), apoi inferenţa prin `executeExchange` (`l.204-220`) cu `WORKER_SCHEMA` (`l.78-100`: narrative, findings[{statement, sources, support}], gaps, confidence). Prompturile de sistem per agent (`l.102-125`) includ instrucţiunea că textul dintre delimitatorii RONOR-TOOL-DATA este **date neîncrezute**. Plafon `UNVERIFIED_CONFIDENCE_CEILING = 85` (`l.76`), coborât la min(85, 60) în regim degradat (`l.320-322`). `extractWorkerOutput` (`l.314-372`) degradează în trepte (fence → acolade → text integral) şi marchează `structure_degraded`.

Punct arhitectural important: **modelul nu poate cere unelte.** `planToolCalls` (`l.383-404`) este determinist — coordonatorul planifică; `web.fetch` se admite doar pentru URL-uri prezente literal în instrucţiune, maximum 3 (`l.396-401`); `knowledge.search` rulează cu k=6.

### 3.4 Descompunere

`agents/decompose.ts` (415 l) — planificator bazat pe model, cu `PLAN_SCHEMA` (`l.57-80`), minItems 1 / maxItems 8, `agent_id` restrâns la enum-ul celor trei lucrători. `decomposeObjective` (`l.83`) limitează `maxTasks` la 2..8, implicit 4 (`l.89`), şi returnează `ok:false` dacă niciun paşaport nu acoperă nivelul de confidenţialitate cerut (`l.92-104`). Reparaţiile sunt **numite şi înregistrate**: R1_STRIPPED_CODE_FENCE (`l.210`), R2_EXTRACTED_JSON_FROM_PROSE (`l.218`), R3_DROPPED_UNKNOWN_AGENT (`l.271`), R4_DROPPED_DUPLICATE_TASK_ID (`l.280`), R5_TRUNCATED_TO_MAX_TASKS (`l.288`), R6_REMOVED_DANGLING_DEPENDENCY (`l.296`), R7_BROKE_DEPENDENCY_CYCLE (`l.303`). `topologicalOrder` (`l.317-345`) rupe ciclurile. Există un plan de rezervă determinist gather → analyse → verify (`fallbackPlan`, `l.365-411`).

### 3.5 Coordonare şi delegare

`agents/coordinator.ts` (772 l). `dispatchMission` (`l.120+`) execută în ordinea: creare/reluare misiune (`l.129-140`) → `setMissionStatus(missionId,'executing')` → `agentsFor()` → **evaluare de guvernanţă înaintea oricărei cheltuieli** (`l.144-206`; suprafaţă `agent`, tip sarcină `decomposition`, încredere 0,6 nemăsurată, `hasSideEffects: true`, impact în EUR din `max_cost_usd`) → dacă se cere co-semnătură şi nu există aprobare anterioară: `createPendingExecution` + status `open` + înregistrare de audit `held-for-cosign` + rezultat blocat (`l.172-200`) → descompunere → buclă secvenţială de dispecerizare (`l.271+`), cu bugetul verificat **între** sarcini (`l.276-279`) → o linie de Work Ledger per lucrător (`recordWork`, `l.330+`) → sinteză (`l.602+`, interzis să introducă fapte noi; cade pe ieşirea verbatim a lucrătorului la `l.644-648`) → `recordValue` în Cost Ledger, `appendToMission` (`l.524`) şi înregistrare de audit (`l.463`). Rândul de misiune poartă **doar** costul sintezei (`l.501-504`).

---

## 4. `api/` — suprafaţa guvernată

### 4.1 Autentificare

`api/auth.ts` (287 l). Chei API stocate **exclusiv ca SHA-256** (`l.46-48`), comparate în timp constant prin `crypto.timingSafeEqual` (`digestsEqual`, `l.51-56`), în tabela SQLite `runtime_api_keys` (obţinută prin `getDb()` din `../../audit/hash-chain`, `l.29`). Roluri: architect | admin | operator | readonly (`l.32`). `key_id = key_${hash.slice(0,12)}` (`l.69`). `authenticate` (`l.129-169`) parcurge toate rândurile active în timp constant şi actualizează `last_used_at`.

Bootstrap (`l.184-254`): `RONOR_ARCHITECT_API_KEY` (etichetă `merlin`, scopuri architect/query/agent/read/admin/ingest, `RONOR_ARCHITECT_RATE_LIMIT_RPM` implicit 240); `RONOR_ADMIN_API_KEY` (`bootstrap-admin`, 240 rpm); `RONOR_API_KEYS` ca CSV `label:secret` cu rol operator şi `RONOR_RATE_LIMIT_RPM` implicit 60; compatibilitate `GATEWAY_API_KEY` / `RATE_LIMIT_RPM`. `hasScope` (`l.279-287`): architect primeşte tot; scopul `architect` este **refuzat** rolului admin. Cheia implicită nesigură `ronor-dev-key-change-in-production` (`l.35`) este raportată public prin `insecureDefaultActive()` (`l.270-277`) şi apare în `security_findings` la `/status` (`routes.ts:1117-1119`).

### 4.2 Middleware

`api/middleware.ts` (236 l). `Provenance` (`l.28-39`): request_id, received_at, client_ip, user_agent, api_key_id, api_key_label, role, sanitisation_verdict, sanitisation_findings. `newRequestId()` = `req_${base36 timestamp}_${6 octeţi hex}` (`l.51-55`), returnat în antetul `X-RONOR-Request-Id` (`l.73`). Secretul se acceptă din `Authorization: Bearer` sau `X-RONOR-API-Key` (`l.77-83`). `requireAuth(scope)` produce 401 uniform / 403 cu `required_scope` (`l.92-128`). `requireArchitect` (`l.131-140`) cere **simultan** rol `architect` şi etichetă `merlin`. `rateLimit` (`l.146-195`) este o fereastră fixă de 60.000 ms per cheie, în proces, cu antete X-RateLimit-Limit/Remaining/Reset şi `X-RateLimit-Scope: per-instance` — limitare onestă, nu distribuită. `errorHandler` (`l.208-227`) nu scurge stack trace şi suprimă detaliul când `NODE_ENV === 'production'`.

### 4.3 Pipeline

`api/pipeline.ts` (556 l), ordine documentată la `l.6-7`: **sanitize → classify → retrieve (L2) → govern (MI9) → route+execute (L1) → verify → ledger (L7) → audit chain → respond**. Ordinea din cod:

1. **Sanitizare** (`l.127-155`) — un refuz este totuşi înregistrat în ledger şi în lanţul de audit; clasificarea are loc la `l.132`.
2. **Recuperare** (`l.158-164`) — `retrieveContext`, prompt compus.
3. **Guvernanţă** (`l.166-256`) — se rulează mai întâi un **exchange dry-run** (`l.169-176`) pentru a cunoaşte motorul candidat, astfel încât înregistrarea de audit să descrie decizia reală; căi separate pentru `rejected-policy` (`l.180-195`) şi `rejected-governance` (`l.220-236`); `request.dry_run` iese devreme (`l.239-256`).
4. **Execuţie** (`l.259-277`).

Există un singur punct de scriere-şi-răspuns, `terminate()` (`l.288+` / `l.503+`). Confidenţialitatea implicită este `internal` (`l.125`). `QueryResponse.economics` conţine `premium_cost_usd` şi `cost_avoided_usd` (`l.106-108`), calculate prin `premiumCostFor` (`l.533-541`), care compară motorul ales cu cel de calitate maximă eligibil şi raportează un `qualityDelta` negativ când s-a plătit mai puţin pentru calitate mai mică.

### 4.4 Guvernanţă (puntea MI9)

`api/governance-bridge.ts` (272 l) traduce cererea de runtime în `DecisionContext` MI9, importând `append` din `../../audit/hash-chain` şi `evaluate, recordExecution` din `../../governance/mi9-gate` (`l.35-36`). Cele nouă porţi din `src/governance/mi9-gate.ts` sunt: sovereignty (`l.273`), risk-tier (`l.301`), reversibility (`l.338`), impact-magnitude (`l.359`), confidence (`l.401`), evidence (`l.428`), policy-compliance (`l.464`), rate-limits (`l.480`), fallback (`l.530`); verdictul global este cel mai strict dintre porţi (`mi9-gate.ts:25-26`).

Traducerea: `RuntimeSurface` = query | agent | worker | tool | ingest (`l.42`); `PARAMETRIC_EVIDENCE_AGE_MS = 30 zile` (`l.80`) când nu există recuperare; rezidenţa este **întotdeauna** `'eu'`, niciodată `'any'` (`l.85-90`); `reversible: !hasSideEffects` (`l.124`); magnitudinea implicită de impact 1000 cu efecte secundare, altfel 1 (`l.131`); `consensusReached: sourceCount >= 2` (`l.141`). `evaluateGovernance` (`l.169-183`): `allowed = verdict !== 'block'`, iar `requiresCoSign = humanCoSignRequired || (hasSideEffects && verdict === 'escalate')`. Bugetul se debitează **numai după** execuţia reală (`recordGovernedExecution`, `l.188-190`). `writeAuditRecord` (`l.225-256`) adaugă în lanţul SHA-256 pe **fiecare** cale terminală, cu `runtime_version: 'runtime-active'`; `outcomeActionFor` (`l.206-215`) mapează la blocked | escalated | held-for-cosign | executed. `deriveConfidenceFromQuality` limitează la 0,3..**0,9** (`l.269-271`) — runtime-ul nu îşi acordă niciodată certitudine deplină.

### 4.5 Aprobări şi protecţie la reluare

`api/approval-settlement.ts` (77 l) — `Map` în memorie (`l.21`). `createPendingExecution` (`l.29-49`) generează `rapv_${24 octeţi base64url}`. TTL din `RONOR_APPROVAL_TTL_MINUTES`, implicit 15 minute, limitat la 1..60 (`l.23-27`). `consumePendingExecution` (`l.55-69`) distinge not-found | **expired** (şterge) | **key-mismatch** (cere acelaşi `api_key_id`) | ready, şi **şterge intrarea înaintea execuţiei** (`l.66-67`) — astfel o decontare reluată sau concurentă nu poate executa a doua oară. Aceasta este protecţia la replay. `rejectPendingExecution` (`l.71-73`) reutilizează acelaşi consum. Tipuri de aprobare: `'query' | 'mission'`. Decontarea se expune prin `POST /approvals/:id/settle` (`routes.ts:293`, apel `consumePendingExecution` la `routes.ts:308`).

Notă: fiind în memorie, aprobările în aşteptare **nu supravieţuiesc unei reporniri** — limitare reală de disponibilitate, nu de securitate (efectul unei reporniri este refuzul, nu execuţia).

### 4.6 Clasificare şi sanitizare

`api/classify.ts` (202 l): produce `Classification` (`l.26-38`) cu task_type, complexity (trivial | simple | moderate | complex, `l.24`), reasoning_effort (none | low | medium | high), `suggested_max_output_tokens` şi lista de **semnale numite** pentru provenienţă. Un `task_type` declarat de apelant câştigă întotdeauna, marcat `C0_CALLER_DECLARED` (`l.64-72`). Semnalele euristice: C1_ARITHMETIC, C2_VERIFICATION, C3_EXTRACTION, C4_SUMMARY, C5_SYNTHESIS, C6_VALIDATION, C7_ANALYSIS, C8_RECENCY, C9_LOOKUP, C10_DEFAULT_REASONING, C11_DECOMPOSITION (`l.82-117`), plus semnalele de complexitate X0_TRIVIAL_ARITHMETIC…X3_COMPLEX (`l.131-155`).

`api/sanitize.ts` (207 l): verdict `clean | suspicious | hostile` (`l.34`), `MAX_QUERY_CHARS = 100_000`, `MAX_FIELD_CHARS = 4_000` (`l.50-51`). Modele ostile (exfiltrare de instrucţiuni, impersonarea stratului de guvernanţă, încărcături codificate, `l.62-79`) duc la refuz; cele suspecte **trec şi se înregistrează**, cu justificarea explicită că altfel runtime-ul nu ar putea analiza chiar materialul pentru care există (`l.176-178`). `stripDangerousChars` (`l.97-123`) elimină, în ordine load-bearing declarată (`l.100-103`), secvenţe ANSI CSI şi OSC, escape-uri de două caractere, controale C0, suprascrieri bidirecţionale (Trojan Source) şi caractere de lăţime zero; o curăţare masivă este ea însăşi semnal (`l.163-164`). `sanitiseIdentifier` (`l.191`) restrânge identificatorii la o clasă conservatoare de caractere.

### 4.7 Rute

`api/routes.ts` (1220 l) — 41 de rute. Operaţionale: `/health` (`l.192`), `/query` (`l.245`, scop query), `/approvals/:id/settle` (`l.293`), `/missions` POST/GET (`l.349/375`), `/missions/:id` GET/PATCH (`l.384/398`), `/missions/:id/fabric` (`l.424`), `/missions/:id/fabric/events` (`l.438`), `/agents` (`l.509`), `/agents/dispatch` (`l.852`, scop agent), `/knowledge/ingest` (`l.894`, scop ingest), `/knowledge/status`, `/providers`, `/catalogue`, `/telemetry`, `/ledger/work`, `/ledger/work/:id`, `/ledger/cost`, **`/ledger/value`** (`l.1048`), `/audit`, `/audit/verify`, `/status` (`l.1090`), `/management`, `/management/:id`, `/management/executive/delegate`. Administrare de chei sub scopul `admin`: GET/POST `/admin/keys`, DELETE `/admin/keys/:keyId` (`l.1129-1166`). Suprafaţa de control cere `requireArchitect`: `/control/session`, `/control/overview`, `/control/council`, `/control/council/:id`, `/control/models`, `/control/missions/:id/fabric`, `/control/automation/readiness`, `/control/automation/plan`, `/control/automation/run`, `/control/automation/runs/:runId`, `/control/automation/runs/:runId/cancel`, `/control/executive/delegate`.

---

## 5. `ledgers/` — contabilitatea operaţională

`ledgers/schema.ts` (192 l): trei registre plus tabele auxiliare, **în acelaşi fişier SQLite care găzduieşte lanţul de audit SHA-256** (`getDb()` din `../../audit/hash-chain`, `l.36`), astfel încât un auditor reconciliază munca prestată cu evidenţa înregistrată printr-o singură interogare (`l.4-7`). Migraţie idempotentă cu gardă `ensured` (`l.40-43`) şi un ALTER defensiv pentru `cancel_requested_at` (`l.182-185`).

| Tabelă | Linii | Câmpuri persistate |
|---|---|---|
| `runtime_work` | 46-73 | request_id (UNIQUE), mission_id, operator_id, api_key_id, task_type, confidentiality, surface, agent_id, status, chosen_model_id, chosen_provider, transport, input_tokens, output_tokens, usage_estimated, cost_usd, latency_ms, attempts, fallback_used, verified_confidence, citations_count, mi9_verdict, trace_hash, **prompt_digest** (SHA-256; niciodată promptul), created_at |
| `runtime_attempts` | 81-97 | request_id, attempt_no, model_id, provider, transport, ok, latency_ms, input_tokens, output_tokens, cost_usd, failure_kind, failure_message, fallback_reason, created_at |
| `runtime_value` | 103-122 | request_id, mission_id, cost_usd, **premium_cost_usd**, **cost_avoided_usd**, **quality_delta**, verified_confidence, declared_value_usd, value_unit, created_at |
| `runtime_api_keys` | 127-140 | key_id, key_hash, label, role, scopes, rate_limit_rpm, active, created_at, last_used_at |
| `runtime_missions` | 144-158 | mission_id, title, objective, status, operator_id, state_json, requests_count, cost_usd, created_at, updated_at |
| `runtime_automation_runs` | 162-177 | run_id, mandate_id (UNIQUE), mission_id, mandate_fingerprint, mandate_json, status, lease_token, lease_owner, lease_expires_at, attempt_count, created_at, updated_at, completed_at, cancel_requested_at |

Două decizii de schemă sunt documentate explicit (`l.22-31`): costurile sunt `REAL`, nu întregi scalaţi, pentru că preţurile per cerere coboară la opt zecimale; iar `usage_estimated` este **coloană**, nu notă de subsol, ca un tablou de bord să nu prezinte cheltuiala inferată identic cu cea măsurată.

`ledgers/work-ledger.ts` (279 l): `digestPrompt` (`l.79`), `recordWork` cu UPSERT pe request_id (`l.83-138`), `recordAttempts` (`l.140`), interogări `countWork`, `listWork`, `getWork`, `attemptsFor`, `recentAttemptSamples` (aceasta din urmă alimentează calibratorul). Promptul nu se stochează niciodată (`l.10`).

`ledgers/cost-ledger.ts` (279 l): `getCostSummary` (`l.63`) cu defalcare per model, cost risipit şi rată de fallback; secţiunea „Value ledger" începe la `l.186`. `recordValue` (`l.202-224`) calculează `cost_avoided = premium_cost_usd − cost_usd`, rotunjit la 8 zecimale (`l.204`). `getValueSummary` (`l.245-278`) agregă cost total, cost premium, cost evitat, valoare declarată şi un `value_multiple = declarat / cost` (`l.277`).

### Există un „Value Ledger" sau un „net verified gain"?

- **Value Ledger: da.** Tabela `runtime_value` (`schema.ts:103-122`), scrierea prin `recordValue` (`cost-ledger.ts:202`), citirea prin `getValueSummary` (`l.245`) şi expunerea prin `GET /ledger/value` (`routes.ts:1048`) şi în `/status` (`routes.ts:1121`).
- **„Net verified gain": nu există.** Căutarea `grep -rn -i "net_verified\|net verified\|netVerified" src` nu returnează nimic. Cea mai apropiată construcţie este `cost_avoided_usd` corelat cu `quality_delta` (cost evitat, calificat de pierderea de calitate) plus câmpurile `baselineValue / proposedValue / incrementalGain / unit` din `AuditRecord.outcome` folosite de `governance-bridge.ts:243-248`. Un câştig **verificat** net nu se calculează: câmpul `verified_confidence` este scris ca `null` pe calea de interogare (`pipeline.ts:358, 392`), iar `confidenceMeasured: false` (`pipeline.ts:207`). Cu alte cuvinte, latura „valoare" este contabilizată, dar latura „verificat" nu este încă măsurată pentru interogările simple.

---

## 6. `automation/` — 31 fişiere, executor guvernat

Grupare tematică, cu ce impune fiecare fişier.

### Capabilitate şi mandat

| Fişier | Linii | Ce impune |
|---|---|---|
| `contracts.ts` | 77 | Vocabularul canonic: 15 `AUTOMATION_ACTIONS`, `ExecutionMandate`, `PlannedAssignment`, `EvidenceArtifact`, `VerificationReceipt`, `AutomationRun` (`l.1-77`). |
| `policy.ts` | 43 | Şase acţiuni implicit permise (read_repo, create_branch, edit_worktree, run_tests, commit_local, prepare_draft_pr) şi nouă **întotdeauna refuzate** (external_send, secrets_read, main_write, push, merge, release, deploy, financial_action, destructive_action) (`l.4-10`); `validateMandate` verifică emitent, hash de obiectiv, workspace, prefix de ramură, fereastră de valabilitate şi limite (`l.16-37`). |
| `mandate-issuer.ts` | 98 | Numai „merlin" emite; identitatea cheii trebuie să respecte `^key_[a-f0-9]{12}$` (`l.72`); ramurile `main`/`master` sunt refuzate (`l.74`); limitele trebuie să încapă în plafoanele de politică (`l.24-27`); mandatul se semnează HMAC pe JSON stabil, cheie ≥ 32 octeţi (`l.39-43, 52-70`). |
| `capability.ts` | 37 | Jeton de capabilitate HMAC-SHA256 pentru audienţa `openhands-bridge`, cu nonce şi expirare, verificat în timp constant (`l.18-36`). |
| `effect-policy.ts` | 45 | Inspectează **acţiunile în aşteptare**, nu observaţiile sau proza modelului (`l.13-22`); refuză `git push`, mutaţii de remote, metadata cloud, reţele private, evadare din workspace, clienţi de reţea, escaladare de privilegii, comenzi distructive (`l.27-36`); refuză orice mandat cu capabilităţi consecvenţiale (`l.38-40`). |
| `workspace.ts` | 70 | Inspectează şi validează workspace-ul: cale canonică, rădăcină aprobată, prefix de ramură, origine şi HEAD aşteptate, arbore curat (`l.36-69`). |

### Politică şi efecte în execuţie

| Fişier | Linii | Ce impune |
|---|---|---|
| `runner.ts` | 233 | Orchestratorul: verifică autoritatea mandatului, existenţa misiunii şi **integritatea ţesăturii de misiune** înainte de orice (`l.74-84`), apoi planificare (LangGraph) → execuţie (OpenHands) → verificare (Codex) → asigurare independentă (Victoria), cu verificări de anulare, expirare şi buget la fiecare tranziţie (`l.152-231`); fiecare etapă emite evenimente în ţesătură. |
| `output-safety.ts` | 27 | `assertAutomationOutputSafe` blochează ieşiri care conţin chei private, jetoane Bearer, chei AWS/GitHub sau secrete etichetate (`l.1-12`). |
| `run-control.ts` | 17 | Un singur `runId` activ, cu `AbortController`; anularea verifică potrivirea misiunii (`l.4-16`). |
| `run-lease.ts` | 213 | Lease persistent în SQLite pe `runtime_automation_runs`: amprentă de mandat (`l.25`), revendicare exclusivă (`claimAutomationRun`, `l.164`), cerere de anulare (`l.110`), listare a rulărilor întrerupte (`l.135`). |
| `background-run.ts` | 32 | Lansează rularea în fundal şi returnează un lease cu `finish(status)` (`l.12+`). |
| `recovery-supervisor.ts` | 133 | Supervizor care redescoperă rulările întrerupte şi le reia sub aceeaşi autoritate de mandat (`l.34+`). |

### Verificare şi evidenţă

| Fişier | Linii | Ce impune |
|---|---|---|
| `test-executor.ts` | 61 | Rulează **doar** comenzi din listă albă parsată din configuraţie, cu timeout, şi produce un artefact de evidenţă (`l.7-32`). |
| `post-execution-verifier.ts` | 54 | Verificare post-execuţie delegată unui serviciu HTTP izolat, cu atestare prealabilă (`l.16+`). |
| `verification-receipt.ts` | 49 | Digest de evidenţă, semnare şi verificare a bonului `ronor-codex-receipt/v1` (`l.4-48`). |
| `artifacts.ts` | 107 | Colector de artefacte în workspace: SHA-256, scriere atomică prin rename, verificare ulterioară (`l.10-44`). |
| `attestation.ts` | 108 | Atestare periodică a celor cinci adaptoare (langgraph, openhands, codex, assurance, evidence) cu TTL şi cache (`l.44-62`). |

### Adaptoare

| Fişier | Linii | Ce impune |
|---|---|---|
| `adapters/http.ts` | 165 | Cei patru clienţi HTTP (`createLangGraphAdapter`, `createOpenHandsAdapter`, `createCodexVerifierAdapter`, `createAssuranceAdapter`), cu plafon de răspuns 256 KiB, maximum 25 de sarcini şi verificare de siguranţă a ieşirii (`l.7-8, 60-118`). |
| `adapters/openhands-native.ts` | 136 | Client nativ OpenHands care aplică `evaluateOpenHandsEffects` înainte de a lăsa o acţiune să treacă, cu workspace de container fixat la `/workspace/project` (`l.4-26`). |
| `adapter-registry.ts` | 72 | Poarta de disponibilitate: `RONOR_AUTOMATION_ENABLED === 'true'` (`l.34`), fiecare endpoint trebuie HTTPS sau loopback/host intern nominalizat (`l.20-30`), token obligatoriu, cheie de capabilitate obligatorie pentru OpenHands (`l.42`), şi **detecţie de conflict de identitate** — dacă două autorităţi partajează origine sau token, toate patru sunt marcate `identity-conflict` (`l.43-47`). `ready` cere şi atestare validă (`l.49-51`). |

### Servicii (procese separate, model de încredere distribuit)

| Fişier | Linii | Ce impune |
|---|---|---|
| `services/langgraph-local.ts` | 78 | Serviciu de planificare pe `@langchain/langgraph` (`StateGraph`, `l.42-48`), protejat prin token de serviciu. |
| `services/openhands-bridge.ts` | 170 | Puntea de execuţie: verifică jetonul de capabilitate şi consumă nonce-ul o singură dată (`MemoryCapabilityNonceStore` / `FileCapabilityNonceStore`, `l.14-94`). |
| `services/openhands-bridge-server.ts` | 37 | Pornire de proces; secretele sunt obligatorii (`requiredSecret`). |
| `services/codex-evaluator.ts` | 57 | Evaluator pe OpenAI Responses; respinge orice bază URL care nu e HTTPS sau proxy intern nominalizat (`l.5-8`). |
| `services/verification-authorities.ts` | 102 | Două aplicaţii distincte — verificator Codex (semnează bonul) şi autoritate de asigurare (verifică bonul cu cheia publică) (`l.61-84`). |
| `services/verification-authorities-server.ts` | 24 | Pornire pe rol, cu preţuri validate din secrete. |
| `services/evidence-runner.ts` | 29 | Serviciu izolat care rulează testele şi întoarce artefacte verificate. |
| `services/evidence-runner-server.ts` | 19 | Pornire cu workspace, rădăcină de artefacte şi listă albă de comenzi obligatorii. |
| `services/model-egress-proxy.ts` | 70 | Egress controlat spre modele: numai `/v1/responses`, `/v1/chat/completions`, `/v1/models` (`l.6`), cu jetoane de client separate de cel din amonte. |
| `services/model-egress-proxy-server.ts` | 15 | Validează portul şi ascultă implicit pe `127.0.0.1:3004`. |
| `services/secret-files.ts` | 15 | Secretele se citesc preferenţial din `NAME_FILE`, cu revenire la `NAME` (`l.4-9`) — compatibil cu montarea de secrete. |

Ruta de execuţie `POST /control/automation/run` (`routes.ts:624-700+`) refuză, în ordine: lipsa `approved: true` → 409; prezenţa de câmpuri de autoritate în corpul cererii (`mandate`, `objective`, `issued_by`, `allowed_actions`) → 400 `client_authority_fields_forbidden`; adaptoare neconfigurate → 503; cheie de semnare a mandatului absentă sau < 32 octeţi → 503; politică de mandat încălcată → 422; `RONOR_AUTOMATION_WORKSPACE_ROOT` / `ARTIFACT_ROOT` neconfigurate → 503; evidence runner neconfigurat sau neatestat → 503; workspace neconform → 422.

---

## 7. `mission/store.ts` — Mission State Fabric

`mission/store.ts` (491 l), persistat în coloana `state_json` a `runtime_missions`.

**Tipuri de evenimente (11)**, `l.55-66`: `task.upserted`, `task.status_changed`, `evidence.added`, `coverage.updated`, `failure.recorded`, `checkpoint.created`, `approval.required`, `approval.resolved`, `run.status_changed`, `run.cancel_requested`, `message.recorded`.

**Actori (6)**, `l.72`: human, ronor, codex, langgraph, openhands, agent. Ţesătura este deliberat **neutră faţă de furnizor** — LangGraph, OpenHands, Codex şi operatorii umani scriu prin acelaşi contract (`l.262-265`).

**Lanţ de integritate**: fiecare eveniment are `sequence`, `previous_hash` şi `event_hash` = SHA-256 peste un JSON canonic sortat al nucleului evenimentului (`stableJson`, `l.443-452`; calcul la `l.298-313`); `event_id = mfe_${hash.slice(0,24)}`. `verifyFabricState` / `verifyMissionFabric` (`l.331-362`) recalculează întregul lanţ şi verifică simultan că `version === events.length` şi că `event_head` corespunde ultimului hash; devierea returnează `broken_at`.

**Control de concurenţă**: `appendMissionFabricEvent` (`l.267-324`) rulează într-o tranzacţie `db.transaction(...).immediate()` şi cere `expectedVersion`; nepotrivirea aruncă `MissionFabricConflictError` (`l.291-296`), corupţia detectată aruncă `MissionFabricIntegrityError` (`l.285-290`) **înainte** de orice scriere. Concurenţă optimistă, nu blocare.

**Validare de intrare** (`validateFabricInput`, `l.396-436`): actor şi tip din enumerări închise; `payload` ≤ 16 KiB; refuz pe câmpuri cu nume de secret (`token`, `secret`, `password`, `private_key`, `api_key`); refuz pe conţinut de tip credenţial (blocuri PEM de cheie privată, `Bearer …`, `ghp_`/`sk-`, JWT); `payload.id` obligatoriu, string, ≤ 160 caractere; identificatorii `__proto__`, `prototype`, `constructor` sunt rezervaţi (protecţie la poluare de prototip).

**Proiecţii** (`projectMissionFabric`, `l.365-394`): `tasks` şi `coverage` prin fuziune incrementală, `evidence` şi `approvals` prin înlocuire/fuziune per id, `failures`, `checkpoints` şi `messages` ca liste de evenimente, `runs` cu stare compusă. Proiecţia raportează `version` şi `event_head`, deci un client poate face un append optimist fără să citească evenimentele brute.

---

## 8. `management/` şi `knowledge/bridge.ts`

**`management/registry.ts` (67 l)** — „Ma11AI Executive Intelligence Council": 25 de agenţi de conducere îngheţaţi (`COUNCIL`, `l.34-59`), fiecare cu domeniu din 25 de valori (`l.3-8`), mandat, e-mail nominal şi funcţional pe `ma11ai.com`, şi trei câmpuri constante non-negociabile: `statutory_authority: false`, `external_send_authority: false`, `email_status: 'proposed'` (`l.20-22, 30`). Doar patru raportează direct la `merlin`: richard, victoria (asigurare), william (risc), catherine (conformitate).

**`management/executive.ts` (91 l)** — `planExecutiveDelegation` (`l.37-91`) construieşte o matrice RACI din 11 reguli de rutare pe expresii regulate **bilingve română/engleză** (`l.23-35`), creează misiunea, apoi scrie câte un eveniment `task.upserted` per participant cu `expectedVersion` incrementat (`l.58-70`) şi un eveniment final `approval.required` pentru „merlin-consequential-action" cu declanşatoarele external-send, contract, financial-commitment, merge, release, deployment, destructive-action (`l.71-79`). Riscul (william), conformitatea (catherine) şi securitatea (oliver) sunt consultaţi automat, iar asigurarea independentă (victoria) este plasată **în afara lanţului de execuţie**, ca agentul care implementează să nu se poată aproba singur (`l.53-56`). Comunicarea generată este mereu `status: 'draft'` şi purtă un disclaimer explicit că nu este semnătură de administrator statutar (`l.85-88`).

**`knowledge/bridge.ts` (333 l)** — punte subţire către `RKnowledgePlane` din `../../planes/r-knowledge` (`l.34`), care implementează chunking, embedding cu poartă de egress autorizat, magazin vectorial Qdrant sau SQLite şi clasificare (`l.5-6`; planul are 1.436 linii). `classificationCeilingFor` (`l.116-134`) mapează confidenţialitatea de runtime la plafonul de clasificare al planului — protecţia împotriva scurgerii unui document suveran într-un răspuns de confidenţialitate joasă (`l.113-115`). `retrieveContext` (`l.135-207`) aplică `maxClassification` (`l.163`); `freshestEvidenceAgeMs` (`l.208`) alimentează poarta de evidenţă MI9; `ingestDocuments` (`l.247-291`) implicit `classification: 'INTERNAL'` (`l.271`); `knowledgeStatus` (`l.304-331`) raportează furnizorul de embedding sau `null` când planul nu este disponibil (`l.314`).

---

## 9. Ce e real vs. ce e schelet

### Real şi funcţional

| Subsistem | Dovadă |
|---|---|
| Toate cele 9 adaptoare de provider | Apeluri `fetch` reale: `providers/types.ts:265`, `anthropic.ts:159-171`, `google.ts:170-171`, `openai-compatible.ts:194-209`, `ollama.ts:38`. Zero rezultate pentru `simulated: true` sau `Math.random()` în `src/runtime`. |
| Motor determinist | Parser aritmetic complet, fără `eval` / `new Function` (`deterministic.ts:57-273`). |
| Scoring + politică + catalog | 6 dimensiuni ponderate (`scoring.ts:32-39`), 11 familii de reguli (`policy.ts:113-303`), 24 de intrări de catalog (`catalogue.ts:68-428`). |
| Calibrator | Ferestre glisante reale plus preîncărcare din ledger (`calibrator.ts:32-126`). |
| Lucrători cu paşaport şi 4 unelte | `registry.ts:64-162`, `tools.ts:100-355`, aplicare centralizată a listei albe la `tools.ts:386-407`. |
| Autentificare şi middleware | Hash SHA-256 + comparaţie în timp constant (`auth.ts:46-56`), provenienţă per cerere (`middleware.ts:28-73`). |
| Pipeline de interogare | Cale unică de terminare cu scriere în ledger şi audit pe **fiecare** ieşire (`pipeline.ts:127-503`, `governance-bridge.ts:225-256`). |
| Aprobări cu expirare şi anti-replay | `approval-settlement.ts:23-27, 55-69`. |
| Trei registre SQLite + Value Ledger | `schema.ts:46-177`, `work-ledger.ts:83-178`, `cost-ledger.ts:202-278`. |
| Mission State Fabric | Lanţ hash verificabil şi concurenţă optimistă tranzacţională (`mission/store.ts:267-362`). |
| Consiliu de conducere şi delegare RACI | `management/registry.ts:34-59`, `management/executive.ts:37-91`. |
| Punte de cunoaştere | Delegare reală către un plan de 1.436 linii (`knowledge/bridge.ts:34, 135-207`). |
| Cod de automatizare | Complet, cu 31 de fişiere şi **31 de suite de teste** în `tests/runtime/`, dintre care 16 dedicate automatizării. |

### Schelet, dezactivat sau nemăsurat

| Element | Stare | Dovadă |
|---|---|---|
| Lanţul de automatizare LangGraph → OpenHands → Codex → Victoria | **Implementat, dezactivat implicit.** Necesită `RONOR_AUTOMATION_ENABLED=true`, cinci URL-uri, cinci jetoane, cheie de capabilitate, cheie de semnare de mandat ≥ 32 octeţi, rădăcini de workspace şi artefacte, plus atestare vie. | `adapter-registry.ts:34, 49-51`; `runner: 'implemented-disabled'` la `l.56`; refuzuri 503 în `routes.ts:646-690` |
| Etapa „verify" din pipeline pentru interogări simple | **Nemăsurată.** `verified_confidence` scris ca `null`; încrederea este derivată din `quality_score`, nu verificată. | `pipeline.ts:207` (`confidenceMeasured: false`), `l.358, 392, 434` |
| „Net verified gain" | **Inexistent.** Există cost evitat şi delta de calitate, nu un câştig verificat net. | `grep -rn -i "net_verified" src` → 0; `cost-ledger.ts:202-224` |
| Aprobări în aşteptare | **Doar în memorie**; nu supravieţuiesc repornirii. | `approval-settlement.ts:21` |
| Limitare de rată | **Per instanţă**, nu distribuită — declarat onest în antet. | `middleware.ts:146-195` (`X-RateLimit-Scope: per-instance`) |
| Telemetrie de calibrare | Inel **în proces**; se pierde la repornire, cu reconstrucţie best-effort. | `calibrator.ts:42, 116-126` |
| `model-cabinet.ts` | **Declarativ.** Tablou de intenţie de rutare; multe rute au status `credential-gated`, `install-required` sau `deferred`; nu execută nimic. | `model-cabinet.ts:45-64, 67-75` |
| Ollama | Cod real, dar **inert** fără `OLLAMA_ENABLED=true`; toate cele 9 intrări de catalog Ollama devin neinvocabile. | `ollama.ts:25, 30` |
| E-mailurile consiliului de conducere | `email_status: 'proposed'`, fără autoritate de trimitere externă. | `management/registry.ts:20-22, 30` |
| Modulul vechi simulat | **Încă montat** la `/api/v1` şi `/api/v1/model-exchange`; poate încă returna text simulat. | `src/index.ts:249-251`; `src/model-exchange/engines.ts:131-158, 230-237` |
| Cheie API implicită nesigură | Prezentă în cod ca fallback, dar semnalată public în `/status`. | `auth.ts:35, 270-277`; `routes.ts:1117-1119` |

### Recomandări de remediere, în ordinea riscului

1. **Demontaţi `/api/v1/model-exchange`** sau interziceţi-i răspunsurile `simulated: true` la nivel de middleware; un răspuns simulat servit pe o suprafaţă guvernată contrazice întreaga poziţie de audit (`src/index.ts:249-251`).
2. **Închideţi bucla „verify"** pentru interogări simple: câtă vreme `verified_confidence` este `null` (`pipeline.ts:358`), Value Ledger măsoară cost, nu valoare verificată.
3. **Persistaţi aprobările în aşteptare** în SQLite, cu aceeaşi semantică de ştergere-înainte-de-execuţie, pentru a păstra anti-replay-ul peste reporniri (`approval-settlement.ts:21`).
4. **Mutaţi limitarea de rată** într-un magazin partajat înainte de a rula mai mult de o instanţă (`middleware.ts:146`).
5. **Documentaţi drumul de activare a automatizării** ca listă de verificare; există nouă precondiţii independente, iar oricare lipsă produce un 503 cu cod distinct (`routes.ts:646-700`).
