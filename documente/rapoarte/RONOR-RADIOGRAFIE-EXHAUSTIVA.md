# RONOR — Radiografie exhaustivă

**Sovereign Intelligence Operating Runtime**
Audit complet: 24–25 august 2026 · revizia `44f3798` · patru gazde sondate live

**Metodă.** Fiecare cifră din acest document a fost măsurată: sondare live prin Tailscale pe gazdele reale, citire directă a codului sursă, analiză git pe toate cele 167 de commit-uri și toate cele 24 de ramuri remote. Nu am citat documentația proiectului ca sursă de adevăr — am folosit-o exclusiv ca ipoteză de verificat. În trei cazuri documentația s-a dovedit falsă și am notat asta explicit.

**Constrângeri respectate.** Zero merge, zero push, zero release, zero deploy. Niciun conținut de secret afișat — doar lungime, permisiuni și prefix de hash. Niciun acces la consolă de vendor de pe IP rusesc; tot accesul la servere a trecut prin Tailscale și SSH.

---

# PARTEA 0 — Verdictul

**Nu ai o harababură de proiect. Ai o harababură de contabilitate asupra unui proiect substanțial.**

Cinci propoziții care rezumă tot ce urmează:

1. **Sistemul e mult mai mare decât credeai și decât spune documentația:** 4 gazde, 69 de containere active, 33 de mii de linii de TypeScript, 1.084 de teste care trec, 0 erori de tip.
2. **Rulează trei generații de cod simultan, iar cea mai bună nu e desfășurată.** Runtime-ul de generația a doua (13.114 linii, zero simulare) există doar în teste; în producție rulează cod etichetat `2.0.0-build-week`.
3. **Nu ai pierdut nicio muncă.** Din 24 de ramuri remote, 22 sunt integrate în `main`; celelalte două sunt instantanee pre-squash care ar produce regresii. Zero stash-uri, zero commit-uri orfane. Repo-ul e curat.
4. **Confuzia de conturi și agenți nu a lăsat urme în cod.** Un singur trailer de co-autor în 167 de commit-uri. Atribuirea către Codex trăiește exclusiv în proză, într-un singur paragraf pe care l-ai scris tu.
5. **Golul real nu e de capabilitate, e de coerență:** documentație oprită pe 3 august, versionare care merge înapoi, cinci arhitecturi concurente, și o bază de date expusă public.

Ordinea se face în 9 pași, listați la final. Șase din ei sunt sub o oră de muncă fiecare.

---

# PARTEA I — Harta completă a infrastructurii

## 1.1 Mesh-ul: 7 noduri, 4 gazde reale

| Nod Tailscale | IP tailnet | IP public | Rol real | Stare verificată |
|---|---|---|---|---|
| `ronor-runtime` / `ronor-sovereign` | 100.124.123.90 | **165.245.248.223** | **GAZDA PRIMARĂ — DigitalOcean** | uptime 2 săpt. 2 zile; 4 vCPU, 7,8 G RAM, 155 G disc (16% folosit) |
| `ronor-hetzner` | 100.83.241.57 | `2a01:4f8:1c1a:3d4e::1` | **gazda secundară — Hetzner**, cea mai mare | uptime 1 săpt. 4 zile; 16 vCPU, 30 G RAM, 601 G disc (20%) |
| `vmi3488431` | 100.87.14.42 | — | **Contabo** — Ollama, 11 modele locale, fără GPU | uptime 2 săpt. 4 zile; inactiv în mesh (964 B tx) |
| `do-bastion-agent` | 100.77.197.28 | — | bastion DigitalOcean | online în tailnet; **SSH refuzat pe cheie — NEMAPAT** |
| `DESKTOP-EAPCQUG` | 100.108.229.28 | — | laptop de control (Windows) | activ, releu „hel" |
| `iphone184` | 100.122.21.82 | — | client mobil | online |
| `iphone-se-gen-2` | 100.110.50.9 | — | client mobil | offline |

**Corecția cea mai importantă a acestui audit:** am raportat anterior că „DigitalOcean e mort". **Fals.** Ce e mort e doar *API-ul de inferență* DigitalOcean (`inference.do-ai.run` → HTTP 403, eșec de îndreptățire cu cheie validă). **Dropletul este gazda primară, viu, sănătos, și rulează stiva completă.** Confuzia a venit din faptul că nodul apare în tailnet ca `ronor-runtime`, nu ca „DigitalOcean" — și din faptul că singura sursă care leagă cele două nume este un fișier de note de pe Hetzner, `/opt/ronor-planes/INFRA_NOTES.md`, scris pe 5 august.

## 1.2 Gazda primară — DigitalOcean `ronor-sovereign`

**Aici e aplicația reală.** 14 containere:

| Container | Imagine | Stare |
|---|---|---|
| `ronor-runtime` | `ronor:main-327a037` | Up 3 zile, healthy, `127.0.0.1:3000` |
| `ronor-postgres` | `postgres:16-alpine` | Up 2 săpt., healthy, **`0.0.0.0:5432` — expus** |
| `ronor-redis` | `redis:7-alpine` | Up 5 zile, healthy, `127.0.0.1:6379` |
| `ronor-qdrant` | `qdrant/qdrant:v1.18.3` | Up 5 zile, healthy, `127.0.0.1:6333-6334` |
| `ronor-automation-*` × 7 | `*:main-ee5c1d4` | **toate Up 3 zile, healthy** |
| `ronor-runtime-pre-v050-20260819T204600Z` | `app-ronor:latest` | Exited (0) — rollback păstrat |
| `ronor-redis-pre-v050-...` | `redis:7-alpine` | Exited (0) — rollback păstrat |
| `ronor-telegram` | `app-ronor:latest` | **Exited (0) acum 2 săptămâni** |

**Constatări:**

- **Stiva de automatizare rulează pe AMBELE gazde.** Pe DO, imagini `main-ee5c1d4`, up 3 zile. Pe Hetzner, imagini `:local` construite 24 august, up 40 min – 8 ore. Două desfășurări paralele ale aceleiași stive, din revizii diferite, fără document care să spună care e autoritativă.
- **Aplicația raportează planurile sănătoase.** `GET /health` → `{"status":"ok","version":"1.0.0","planes":[{"planeId":"r-gateway","status":"healthy"},{"r-context":"healthy"},{"r-model-fabric":"healthy"},{"r-agent-runtime":"healthy"},...]}`. Deci planurile TypeScript **rulează** — dar `package.json` din același container declară `2.0.0-build-week`, iar health declară `1.0.0`. Trei versiuni diferite în același proces.
- **Codul sursă e sub git corect** — `/opt/ronor/app`, origin `github.com/Constantin1968/RONOR-.git`, HEAD `6a50a7e` (19 august, AMB, „fix(ci): parse Jest failures from summary only"), pe ramura `fix/release-readiness-conf5`, arbore curat. Deci producția rulează cod de pe **o ramură de fix, nu de pe `main`**, cu 6 zile și ~25 de commit-uri în urmă.
- **Există un strat Python paralel** în `/opt/ronor/`: `main.py`, `api_server.py`, `alert_engine.py`, `scheduler.py`, `telegram_handlers.py`, `seed_data.py`, `venv/`, `db/`, `data/`, `config/`, `logs/` — servit de `ronor.service` („RONOR Memory & Alert Engine"). Nu e în repo.
- **Kitul de automatizare e desfășurat integral:** `automation-artifacts/`, `automation-backups/`, `automation-control/`, `automation-nonces/`, `automation-secrets/`, `automation-worktree/`.
- **Baza de date conține date operaționale reale:** tabelele `r_execute_log`, `r_monitor_alerts`, `r_monitor_health`, `r_schedule_log`.
- Servicii systemd: `ronor.service`, `do-agent.service`, `droplet-agent.service`, `tailscaled.service`.

## 1.3 Gazda secundară — Hetzner `ronor-hetzner`

**55 de containere.** Cea mai mare parte a estate-ului. `/srv/ronor/automation` are doar 12 M; restul stă în `/opt`, care nu e sub git.

### a) Planurile R-* — Python/FastAPI, sondate live, funcționale

Acesta e rezultatul care contrazice cel mai tare documentația canonică, care listează majoritatea planurilor drept „parțiale" sau „roadmap":

| Serviciu | Port | Ce raportează la `/health` |
|---|---|---|
| `ronor-r-comms` | 8100 | `ok` · **`smtp_configured: true`, `imap_configured: true`, `telegram_configured: true`** |
| `ronor-r-memory` | 8101 | `ok` · **`qdrant_ok: true`**, colecție `ronor_memory` |
| `ronor-r-execute` | 8600 | `ok` |
| `ronor-r-monitor` | 8700 | `ok` · **7 verificări active** |
| `ronor-r-schedule` | 8800 | `ok` · **`temporal_connected: true`, `worker_running: true`, 4 programări active** |
| `ronor-tools-gateway` | 8400 | `ok` · 6 unelte: `execute_on_contabo`, `execute_shell`, `health_check`, `query_cida`, `send_email`, `web_search` — plus subset `read_tools` |
| `ronor-orchestrator` | — | `python -u main.py`, imagine `ronor/orchestrator:2.0.0` |

**Tradus în capabilități operaționale, chiar acum, de 11 zile:** sistemul poate trimite și citi e-mail, poate scrie pe Telegram, poate căuta pe web, poate executa shell local, poate executa comenzi pe Contabo, are memorie vectorială persistentă și rulează 4 programări în Temporal.

### b) Restul stivelor

| Grup | Servicii |
|---|---|
| Automatizare (24 aug) | `ronor-automation-{langgraph, openhands-bridge, openhands-agent, codex-verifier, victoria-assurance, model-egress-proxy, automation-evidence-runner}-1` — toate healthy, **0 restarturi** |
| Guvernanță TS | `ronor-governance` (`app-ronor:sovereign-embed`, `node dist/index.js`) + `ronor-gov-postgres` + `ronor-gov-redis` |
| Cadre de agenți | `ronor-langgraph` (:2024) + pg + redis, `ronor-crewai` (:8500), `ronor-autogen` (:8085), `ronor-dify` (api :5001, web :3001, db, redis), `ronor-n8n` (:5678) |
| Orchestrare | `ronor-temporal` 1.29.7 + pg + admin-tools + UI (:8233), `ronor-prefect` (:4200) |
| Bariere de siguranță | `ronor-guardrails-ai` (:8900), `ronor-llm-guard` (:8902, imagine 9,08 G), `ronor-nemo-guardrails` (:8901) |
| Observabilitate | Langfuse complet (web, worker, clickhouse, pg, redis, minio), `ronor-mlflow` (:5050), `ronor-openwebui` (:3003) |
| Vectori | `ronor-qdrant` v1.19.0 + `ronor-qdrant-tls` (nginx) |
| CIDA (arhitectură soră) | `cida-api` (:8300), `cida-worker`, `cida-postgres` 17, `cida-minio`, `cidavault` — toate healthy, 11 zile |
| Poartă de modele | `portkey-gateway` (:8787) |
| Oprite (rollback păstrat) | `ronor-governance-pre-constitutional`, `ronor-governance-prek9_080556`, `ronor-langgraph-old`, `ronor-orchestrator-broken-20260809` (137), `ronor-orchestrator-prev-0149` (137), `ronor-telegram-gov` |

### c) Trei servicii în afara Docker și în afara repo-ului

| Unitate systemd | Descriere proprie |
|---|---|
| `ronor-cc.service` | RONOR Command Center Dashboard |
| `ronor-pool.service` | **RONOR Worker Pool — agenți care execută sarcini autonom** |
| `ronor-telemetry.service` | RONOR Telemetry Aggregator + Dashboard |

`ronor-pool.service` rulează ca `root`, execută sarcini autonom, și **nu trece prin niciun mecanism de guvernanță din repo**.

### d) Inventarul `/opt` — 28 de directoare, niciunul sub git în afară de unul

| Director | Dim. | Ultima atingere | Notă |
|---|---|---|---|
| `ronor-backups` | **14 G** | 10 aug | cel mai mare artefact din estate |
| `ronor` | 418 M | **25 aug 00:27** | git `ca392ef` (9 aug), **remote = NONE** |
| `ronor-governance-migration` | 85 M | 10 aug | migrare neterminată? |
| `ronor-cc` | 75 M | 5 aug | Command Center |
| `ronor-snapshots` | 57 M | 5 aug | |
| `ronor-governance` | 51 M | 9 aug | **codul desfășurat, fără git** |
| `cida-archive` | 29 M | 5 aug | |
| `cidavault` | 20 M | 6 aug | |
| `ronor-expansion` | 14 M | 10 aug | 13 servicii compose |
| `ronor-build` | 4,6 M | 9 aug | 3 fișiere compose |
| `ronor-planes` | 212 K | 17 aug | **conține `INFRA_NOTES.md` — singura hartă existentă** |
| `ronor-security`, `ronor-tools-gateway`, `ronor-orchestrator`, `ronor-qdrant-tls`, `qdrant-tls` | < 100 K | 5–9 aug | |
| `aider`, `tabby`, `flowise` | 8–12 K | 6 aug | **definite, nedesfășurate** |
| `autogen`, `dify`, `langfuse`, `mlflow`, `n8n`, `openwebui`, `portkey`, `prefect`, `cida` | 8 K – 484 K | 5–9 aug | compose-uri active |

### e) Rețele — izolarea e reală, verificată

| Rețea | `internal` | Membri |
|---|---|---|
| `ronor-automation-control` | **true** | bridge, evidence-runner, victoria, langgraph, codex-verifier, openhands-agent |
| `ronor-model-egress` | **true** | model-egress-proxy, codex-verifier, openhands-agent |
| `ronor-model-uplink` | false | **doar** model-egress-proxy |
| `ronor-expansion` | false | 24 de membri |
| `ronor-planes` | false | 8 (planurile R-*, guvernanță, qdrant-tls) |
| `ronor-governance` | false | gov-redis, gov-postgres, tools-gateway |
| `ronor-shared` | false | n8n, dify-*, mlflow, openwebui, autogen, prefect |

Containerele de lucru stau pe rețele `internal: true`, fără rută spre internet; doar proxy-ul atinge uplink-ul. **Deny-by-default nu e o afirmație de document, e o proprietate verificată a rețelei.** Aceasta e cea mai bine construită piesă din tot estate-ul.

### f) Secrete — 13 fișiere, igienă corectă

Toate în `/srv/ronor/automation/secrets/`, toate `mode 640`, proprietar `10001:10001` (non-root). Confirmate doar prin lungime și prefix de hash:

`assurance_receipt_public_key` 113 B · `assurance_token` 64 B · `automation_capability_key` 64 B · `codex_api_key` 64 B · `codex_receipt_private_key` 119 B · `codex_verifier_token` 64 B · `evidence_runner_token` 64 B · `langgraph_token` 64 B · `model_gateway_upstream_token` 117 B (cheia Qwen) · `openhands_bridge_token` 64 B · `openhands_llm_api_key` 64 B · `openhands_secret_key` 64 B · `openhands_session_key` 64 B

## 1.4 Contabo

`vmi3488431`, uptime 2 săpt. 4 zile, **fără GPU**. Ollama cu 11 modele, verificat live de pe Hetzner: `qwen3-coder:30b` (30,5 B, Q4_K_M, context 262.144, capabilități completion + tools), `qwen3.5:35b-a3b`, `deepseek-r1:70b-llama-distill`, `llama3.1:70b`, `qwen2.5:72b-instruct`, `bge-m3`. Fără GPU înseamnă **88 s până la primul token** pe prompt mare — util pentru embedding și sarcini de fundal, nu pentru interactiv. Inactiv în mesh (964 B trafic).

## 1.5 Furnizori de inteligență — stare reală, testată

| Furnizor | Verdict |
|---|---|
| **Qwen / DashScope** | **Funcțional** — `dashscope-intl.aliyuncs.com/compatible-mode/v1`, 162 de modele. Endpoint-ul din China (`dashscope.aliyuncs.com`) → 401. |
| **Contabo / Ollama** | **Funcțional**, dar lent (fără GPU) |
| **DigitalOcean Inference** | **Mort** — 403 cu cheie validă = perete de îndreptățire, nu de rețea |
| Anthropic, Gemini, DeepSeek, Perplexity, OpenAI, Kimi, xAI | chei prezente în `.env.production`; **netestate în acest audit** |

## 1.6 Servicii externe descoperite din numele de variabile

`/opt/ronor/app/.env.production` are **302 linii, ~110 chei**. Trei dependențe externe nu apăreau nicăieri în documentație:

- **Supabase** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_SCHEMA`, `PERSISTENCE_REQUIRED`
- **Cloudflare R2** — `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_REGION`, `R2_PUBLIC_BASE_URL`
- **ElevenLabs** — `ELEVENLABS_API_KEY`

Plus un **sistem de control prin Telegram complet configurat**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_APPROVER_USER_IDS`, `TELEGRAM_CONTROL_CHAT_ID`, `TELEGRAM_MODE`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_APPROVAL_TTL_MINUTES`. Containerul `ronor-telegram` este **oprit de două săptămâni**, iar codul punții Telegram din repo (2.140 de linii) **nu e montat nicăieri**.

---

# PARTEA II — De ce pare harababură: trei generații suprapuse

Aceasta e explicația structurală a confuziei. Nu ai făcut un lucru prost — ai făcut trei lucruri bune, în succesiune rapidă, fără să retragi niciodată precedentul.

| | Generația 1 | Generația 2 (Python) | Generația 3 (TS runtime) |
|---|---|---|---|
| **Când** | 19–21 iulie | 5–9 august | 3–24 august |
| **Unde trăiește** | `src/model-exchange/`, `src/governance/`, `src/audit/`, `src/decision-loop/`, `src/planes/` | `/opt/ronor-planes/`, `/opt/ronor-expansion/` pe Hetzner; `/opt/ronor/*.py` pe DO | `src/runtime/` — 70 fișiere, 13.114 linii |
| **Autor** | tu (1–2 commit-uri pe modul) | în afara git-ului | **tu, 69 de commit-uri** |
| **Rulează?** | **da** — `app-ronor:sovereign-embed`, montat la `/api/v1` | **da** — 11 zile, sănătos, cu date reale | **nu** — doar în teste |
| **Simulează?** | **DA** — `engines.ts:131-158` | nu | **NU** — 0 rezultate la grep |
| **Calitate** | prototip de concurs | funcțional, netestat, nedocumentat | 1.084 teste, 0 erori tip, 0 TODO |

**Concluzia care rezumă întreaga problemă: mecanismele de control cele mai avansate nu protejează sistemele care fac muncă reală, iar sistemele care fac muncă reală nu sunt nici versionate, nici testate.**

Cele șapte imagini de guvernanță construite în 11 ore pe 8–9 august spun povestea acelei nopți: `latest` → `pre-sovereign-20260809` → `sovereign` → `constitutional` → `canon` → `k9` → `sovereign-embed`. Iterație pe modelul de guvernanță, nu pe funcționalitate.

---

# PARTEA III — Capabilitățile reale, verificate în cod

Sursă: `src/runtime/`, citit integral. La revizia `44f3798`: **56/56 suite trec, 1.084/1.084 teste trec, `tsc --noEmit` 0 erori, 0 TODO, 0 FIXME, 0 „not implemented"** în 33.709 linii de TypeScript. Raport test/sursă: 0,45.

| Subsistem | Fișiere / linii | Verdict | Dovada |
|---|---|---|---|
| `providers/` | 13 / 2.279 | **Real, integral. Nicio simulare.** | `grep -rn "simulated: true\|Math.random()" src/runtime` → **0** |
| `api/` | 8 / 3.057 | Real. Pipeline 9 etape, chei hash-uite. | `auth.ts:46-56` |
| `agents/` | 5 / 2.218 | Real. Lucrători digitali cu pașapoarte. | `registry.ts:39-62` |
| `automation/` | 31 / 2.393 | Cod complet, **dezactivat implicit** (9 precondiții) | `adapter-registry.ts:34,49-51` |
| `router/` | 6 / 1.435 | Real. 6 dimensiuni, 11 familii de reguli. | `scoring.ts:32-39`, `policy.ts:113-303` |
| `ledgers/` | 3 / 750 | Real. Value Ledger există; „net verified gain" nu se calculează. | `schema.ts:103-122` vs `pipeline.ts:358,392` |
| `mission/store.ts` | 1 / 491 | Real. Event sourcing, lanț hash, concurență optimistă. | `store.ts:267-324` |
| `knowledge/bridge.ts` | 1 / 333 | Real, delegă la `planes/r-knowledge` (1.436 l) | `bridge.ts:34` |
| `management/` | 2 / 158 | Real, dar declarativ | `registry.ts:34-59` |

## Ce poate face concret

**Rutare pe șase dimensiuni.** `Score = +Calitate − Cost − Latență − RiscOperațional + Suveranitate + Evidență`, ponderi 1,0 / 0,8 / 0,5 / 0,6 / 0,7 / 0,6. Calitatea e ponderată de telemetria observată (`quality_score × successRate`), nu de valoarea declarată. Catalog: 24 de intrări cu jurisdicție, nivel de suveranitate 0–3, fiabilitate a evidenței, risc operațional, fereastră de context.

**Unsprezece familii de politici aplicate ÎNAINTE de scoring** (P0–P9 + P2S): prezența credențialului, doar-suveran, potrivire de capabilitate, determinist-mai-întâi, liste albe/negre, plafon de latență **față de p50 calibrat**, plafon de cost, prag de evidență, filtrare jurisdicțională (setul UE include RO), obligativitatea căutării, și pin-ul de operator — aplicat ultimul și **incapabil să lărgească** setul admis. Fiecare respingere numește regula care a golit setul: refuzurile sunt explicabile.

**Nouă adaptoare cu apeluri HTTP reale:** OpenAI, Anthropic (implementare nativă proprie, nu prin bibliotecă), Google, xAI, DeepSeek, Kimi, Perplexity, Ollama, plus motor determinist local (shunting-yard, fără `eval`). Adaptare per familie reală: `gpt-/o1/o3/o4` → `max_completion_tokens`, `claude` → buget de gândire, `gemini` → effort.

**Calibrare care supraviețuiește repornirii.** Fereastră de 50 de eșantioane, minim 3, p50 doar pe apeluri reușite, preîncărcat din Work Ledger la pornire.

**Lucrători digitali cu mandat.** Trei agenți — `researcher`, `analyst`, `evidence-curator` — fiecare cu pașaport care fixează mandatul, plafonul de confidențialitate (public/internal/restricted/sovereign), lista albă de unelte și pragul de evidență. **Aplicarea listei albe e centralizată în afara modelului: modelul nu poate cere unelte.** Delimitator anti-injection cu nonce per invocare. `analyst` e singurul `sovereign` — și în consecință singurul fără `web.fetch`.

**Autoritate și audit.** Chei SHA-256 cu `timingSafeEqual`, pipeline în 9 etape cu dry-run înaintea guvernanței, audit pe fiecare cale terminală, aprobări cu TTL 15 min și ștergere-înainte-de-execuție (anti-replay).

**Țesătura de stare a misiunii.** 11 tipuri de evenimente, 6 actori (`human`, `ronor`, `codex`, `langgraph`, `openhands`, +1), lanț SHA-256 pe JSON canonic, concurență optimistă prin `expectedVersion`, validare anti-secret și anti-prototype-pollution.

## Corecție pe care mi-o asum

Am afirmat anterior că Value Ledger, Cost Ledger, Mission State Fabric și providerii live au „zero cod". **Toate patru există.** Eroarea a venit din căutarea numelor de fișiere în loc de citirea codului. Ce rămâne valid, în formă corectă: **coada P0 a fost executată sub alte nume, în alt modul, fără actualizarea planului.** Munca există; cartografierea ei nu.

---

# PARTEA IV — Cine a scris ce

## 4.1 Paternitate umană — 167 de commit-uri, 10 identități, 2 persoane

| Commit-uri | Identitate |
|---|---|
| 88 | Constantine Liviu NITA `<liviu.c.nita@gmail.com>` |
| 27 | Merlin the Ancient Architect `<liviu.c.nita@gmail.com>` |
| 21 | AMB (Archeon Master the Best), COO `<amb@mayleven.com>` |
| 16 | AMB `<amb@mayleven.com>` |
| 7 | AMB (Archeon Master the Best) `<office@mayleven.com>` |
| 3 | AMB `<constantine@mayleven.com>` |
| 2 | Constantin Liviu NITA (Merlin) `<merlin@ma11ai.com>` |
| 1 | RONOR Ops `<ops@ronor.local>` |
| 1 | Constantin1968 `<liviu.c.nita@gmail.com>` |
| 1 | Constantin Liviu NITA `<office@mayleven.com>` |

Grupat: **tu — 117 commit-uri** sub 5 nume de afișare și 3 adrese. **Persona AMB — 47** sub 3 nume și 3 adrese. **RONOR Ops — 1.** Committer: +24 `GitHub <noreply@github.com>` (merge-uri prin web).

Proprietate pe module:

| Modul | Linii | Autor |
|---|---|---|
| `src/runtime` | 13.114 | **tu — 69 commit-uri.** Întreg runtime-ul de generația a treia. |
| `src/knowledge` | 6.003 | **AMB — 9 commit-uri** |
| `deploy/` | 1.414 | AMB, 3 august |
| `src/planes` | — | AMB (8) |
| `src/api` | — | AMB (3) |
| `src/model-exchange`, `governance`, `audit`, `decision-loop` | — | tu, 1–2 commit-uri fiecare — **înghețate din iulie** |

## 4.2 Atribuirea către agenți AI — răspunsul direct la întrebarea ta

Ai folosit Codex, apoi Manus, apoi Codex de pe două conturi ChatGPT Pro, plus un cont OpenAI Developer Platform cu trei proiecte. **Din repo, nimic din asta nu se vede.** Rezultatele măsurate:

- **Un singur trailer `Co-authored-by` în 167 de commit-uri**, și acela numește identitatea de serviciu `RONOR Ops <ops@ronor.local>` (în `44f3798`, PR #25). **Zero** trailere `Generated with`, `Co-Authored-By: Claude`, `Co-Authored-By: Codex`.
- Grep-ul pe „codex" produce 22 de potriviri în mesajele de commit: **1 trailer real, 1 linie de proză, 20 fals-pozitive** — pentru că **„Codex" este numele unui serviciu al arhitecturii tale**: containerul `codex-verifier`, portul 3002, trei secrete dedicate (`codex_api_key`, `codex_verifier_token`, `codex_receipt_private_key`), o cheie de semnare Ed25519, și un tip de actor în modelul de misiune. Orice audit naiv pe cuvântul „codex" va supraestima masiv atribuirea AI.
- **Atribuirea reală există doar în proză, într-un singur loc precis** — `DEVPOST_SUBMISSION.md:53`, scris de tine: *„Codex a scris prima versiune a pipeline-ului de orchestrare, implementarea de scoring a routerului, calea de append și verify a lanțului de audit, și majoritatea UI-ului de operator. Am revizuit, testat și editat fiecare fișier generat înainte de a fi comis. Nimic nu a fost acceptat orbește."*
- Corelat cu inventarul de cod, zona revendicată pentru Codex acoperă: `src/orchestrator.ts` (156 l), `src/model-exchange/` (6 fișiere, 1.406 l), `src/runtime/router/scoring.ts`, `src/audit/hash-chain.ts` (345 l), `web/` (9 fișiere). **Epoca hackathon, 19–21 iulie — nu programul de automatizare din august.**
- **Manus: două apariții, zero cod.** `AMB_BUILD_NOTES.md:14` — `OPENAI_API_BASE=https://api.manus.im/api/llm-proxy/v1`, descris ca „OpenAI-compatible multi-vendor gateway". Aceasta e singura dovadă că infrastructura Manus a fost folosită: **ca gateway de modele în timpul construcțiilor etichetate AMB, 3 august.** A doua apariție, `docs/executive-automation.md:329` — *„Manus rămâne amânat până după 26 august 2026; nicio credențială sau cale de execuție Manus nu e activată."* Interdicție explicită, datată, scrisă de tine pe 21 august.
- **Dovada de utilizare Codex cerută de regulamentul hackathon-ului nu a fost niciodată completată.** `DEVPOST_SUBMISSION.md:97` conține încă `[session ID from /feedback — added at submission]`.

**Consecința practică pentru tine:** confuzia de conturi nu a produs dezordine în cod. Repo-ul e coerent și are un singur proprietar tehnic. Ce s-a pierdut e **trasabilitatea**: nu poți demonstra, din artefacte, ce a generat care agent de pe care cont. Dacă asta contează pentru concurs sau pentru audit extern, se recuperează doar din istoricul conturilor OpenAI, nu din repo.

## 4.3 Cele cinci etape de dezvoltare, și motivul fiecăreia

**1. 19–21 iulie — Build Week.** 3 commit-uri mari. *Motiv: termenul concursului OpenAI.* Rutare 6D, poarta MI9, lanț audit SHA-256, scenariu BESS 20 MWh (OPCOM DAM + aFRR), UI 3 tab-uri, submisie Devpost, script video. `1.0.0` → `2.0.0-build-week`, 43 de teste.

**2. 1–3 august — trei programe MIP, 40 de commit-uri.** *Motiv: transformarea unui prototip de concurs în ceva operabil.*
- **MIP-012**: CI, workflow de release, checksums, 4 șabloane de issue, CODEOWNERS, docker-compose, CHANGELOG
- **MIP-013 R-Sentinel**: 3 colectoare de telemetrie, ring buffer, prognozator, motor de alerte, degradare graduală
- **MIP-014 R-Knowledge**: al 9-lea plan, **inert implicit** — activarea cere `KNOWLEDGE_ENABLED` exact `true`; starea dezactivată e observațional identică cu `d058544d`. 14 câmpuri obligatorii, invarianți K-INV-1…7, 3 depozite vectoriale, scară de degradare reversibilă pe 4 niveluri
- Rezultat `v0.4.0-core-active`: 23 suite, 594 teste

**3. 5–9 august — desfășurarea infrastructurii, în afara repo-ului.** *Motiv: nevoia de sistem care rulează, nu de cod care compilează.* Aici au apărut planurile Python R-*, CIDA, Langfuse, Temporal, cele trei sisteme de bariere, Qdrant, Command Center, Worker Pool. **Nimic din asta nu e urmărit în git** — de aceea nu apărea în niciun audit de cod.

**4. 19 august — reconciliere, 16 commit-uri.** *Motiv: exista un worktree cu muncă nepredată.* PR #6 a consolidat: corecții de contabilitate MI9, providerul Kimi, rutare Telegram, configurație de producție sanitizată, invarianți de deploy, aprobări cu expirare + legare la cheia API + anti-replay. PR #7 a corectat un fals-negativ în verificator. `v0.5.0-20260819`, 30 suite, 891 teste. Deliberat: fără apeluri live, fără deploy.

**5. 20–25 august — planul de automatizare guvernată, ~101 commit-uri.** Perioada cea mai intensă. *Motiv: a face sistemul capabil să execute muncă de inginerie sub guvernanță.* PR #9 granița de execuție, PR #10 ciclul de viață al rulărilor, PR #13/#14 egress deny-by-default, PR #16–#21 șase corecții OpenHands, PR #22 cale de audit izolată, PR #23 kit de activare versionat, PR #24 eliminarea SHA-ului hardcodat, PR #25 porturi configurabile.

**Apoi, noaptea de 24–25 august: prima activare live.** 8 defecte identificate, DO Inference confirmat mort, Qwen confirmat funcțional, agentul face muncă reală de inginerie — dar e tăiat la 120 de secunde.

**Arcul corpusului de teste: 43 → 594 → 891 → 1.084.** Cifra care spune cel mai mult despre disciplină: testele au urmat codul la fiecare etapă.

## 4.4 Starea repo-ului — curat, contrar așteptărilor

- **Nu există muncă funcțională nemergeuită.** Din 24 de ramuri remote, **22 sunt strămoși integrali ai `origin/main`**. Cele două care raportează commit-uri în avans — `origin/chore/unpin-approved-sha` (2) și `origin/automation/parameterize-host-ports` (1) — sunt instantanee pre-squash ale PR #24 și #25. Aplicarea lor ar **reintroduce** SHA-ul hardcodat și ar **elimina** parametrizarea porturilor. **Sunt sigur ștergibile.**
- **Zero stash-uri, zero worktree-uri secundare, zero commit-uri orfane** (`git fsck --unreachable --dangling` vid), zero fișiere netracked.
- Singura divergență reală: **ramura locală `main` (`264a55b`) e cu 2 commit-uri în urma lui `origin/main` (`44f3798`)**. Orice preflight care compară HEAD-ul local cu SHA-ul aprobat va evalua o stare depășită.

---

# PARTEA V — Securitate

## 5.1 O expunere reală, confirmată

**Postgres 16 pe `165.245.248.223:5432` este accesibil din internetul public.**

Verificat de pe rețea externă, la nivel de protocol: `SSLRequest` → răspuns `N` (fără TLS), `StartupMessage` → **`SASL/SCRAM` cerut** pentru ambii utilizatori testați (`ronor`, `postgres`). Nu am trimis nicio parolă și nu am citit nicio dată.

Deci: **expus, dar protejat prin parolă SCRAM-SHA-256, fără TLS.** Nu e catastrofă, e risc real — suprafață de brute-force, amprentare de versiune, trafic în clar. Cauza: `ufw` **nu** permite 5432, dar `docker-proxy` inserează reguli în lanțul `DOCKER` care **ocolesc ufw**. Este eroarea clasică Docker/ufw.

Baza conține tabelele operaționale ale planurilor R-*: `r_execute_log`, `r_monitor_alerts`, `r_monitor_health`, `r_schedule_log`.

**Remediu, o linie:** schimbă maparea din `0.0.0.0:5432:5432` în `127.0.0.1:5432:5432` în compose-ul de pe DO și repornește containerul.

Verificate ca **NEexpuse** (timeout la nivel de protocol, deci filtrate corect): 6379 Redis, 6333 Qdrant, 3000 aplicația. Portul de control 9999 a răspuns identic, ceea ce confirmă că un test naiv de conexiune TCP dă fals-pozitive pe această rută — de aceea am verificat la nivel de protocol.

## 5.2 Igienă imperfectă, fără risc live

Pe Hetzner, două servicii Python ascultă pe `0.0.0.0`: `telemetry_aggregator.py` (:8401, răspunde HTTP 200 **fără autentificare**) și `pool_service.py` (:8402). Testate din exterior: **filtrate de ufw**. Rămâne o legare prea largă care depinde de o singură linie de apărare.

## 5.3 Golul de control cel mai mare

**`ronor-tools-gateway` expune `execute_shell` și `execute_on_contabo`**, iar **`ronor-pool.service` rulează agenți autonomi ca `root`** — ambele complet în afara porții MI9, a pașapoartelor de agent și a lanțului de audit implementate în runtime. Execuție arbitrară pe două gazde, fără guvernanță. Aceasta e cea mai mare inconsistență dintre ce ai construit și ce protejezi.

## 5.4 Slăbiciuni de proces în CI

- **Scanarea de secrete e neblocantă** — `ci.yml:71`, pasul TruffleHog are `continue-on-error: true`. Un secret verificat comis în istoric ar produce un CI verde.
- **ESLint nu rulează niciodată în CI.** `package.json` definește `lint`, `eslint.config.mjs` există, niciun job nu îl invocă. Verificarea de tip se face doar indirect, prin `npm run build`.
- **`main` nu e etichetat și nu a trecut niciodată prin `release.yml`** — workflow-ul se declanșează doar pe etichete `v*`, ultima e din 19 august. Tot kitul de activare (PR #22–#25) a intrat fără verificare de release.
- **Politica de protecție a ramurii nu e versionată**, deci nu e verificabilă din clonă. `CODEOWNERS` are o singură regulă (`* @Constantin1968`) — un singur proprietar și un singur revizor, care coincide cu autorul a 117 din 167 de commit-uri.

---

# PARTEA VI — Registrul complet de datorii

## A. Coerență de sistem (cele mai grave)

1. **Trei generații rulează simultan fără să se cunoască.** Cea mai bună (13.114 linii, zero simulare) nu e desfășurată deloc.
2. **Cod desfășurat fără trasabilitate.** `/opt/ronor-governance/app_k9` pe Hetzner nu are git. `/opt/ronor` are git dar **remote = NONE**. Nu se poate stabili ce commit rulează în producție pe Hetzner.
3. **Producția pe DO rulează o ramură de fix, nu `main`** — `fix/release-readiness-conf5` la `6a50a7e`, cu ~25 de commit-uri în urmă.
4. **Trei versiuni în același proces:** health spune `1.0.0`, `package.json` spune `2.0.0-build-week`, imaginea e `ronor:main-327a037`.
5. **Stiva de automatizare rulează dublu**, din revizii diferite, pe ambele gazde, fără document de departajare.
6. **Modulul vechi simulat rămâne montat** la `/api/v1/model-exchange` (`src/index.ts:249-251`). Un apelant pe calea veche primește text simulat marcat ca răspuns. Risc reputațional, remediere de 30 de minute.
7. **`bastion-agent` (100.77.197.28) rămâne nemapat** — SSH refuzat pe cheie de pe Hetzner.
8. **Infrastructura de pe `/opt` (Hetzner) nu e versionată nicăieri.** 28 de directoare, 14 G de backup-uri, singura hartă existentă e un fișier de note din 5 august.

## B. Funcțional

9. **„Net verified gain" nu se calculează.** `verified_confidence` scris `null` (`pipeline.ts:358, 392`), `confidenceMeasured: false`. **Singura dependență reală a pilotului OSaaS.**
10. **Buget de misiune hardcodat la 120 s** — `maxPolls ?? 120 × pollIntervalMs ?? 1000` în `openhands-bridge-server.ts`, necablat la mediu.
11. **Puntea Telegram, 2.140 de linii, nu e montată nicăieri** — comentariul propriu spune că `startTelegramBridge()` se apelează din `src/index.ts`, dar apelul nu există. Are teste care trec, deci CI nu semnalează. Containerul `ronor-telegram` e oprit de 2 săptămâni, deși toate cele 9 variabile Telegram sunt configurate.
12. **825 de linii de cod complet orfan:** `src/model-exchange/engines.ts` (329), `src/persistence/memory-manager.ts` (222, expune un singleton neapelat), 2 duplicate `src/scripts/provision-*.ts` (274).
13. **Scripturi de provizionare duplicate cu implementări divergente** — `provision-qdrant.ts` există în `scripts/` și `src/scripts/`, unul folosește `client.api('cluster').clusterStatus()`, celălalt `client.versionInfo()`. Niciunul nu e referit din `package.json`; **nu se poate stabili din repo care e corect.**
14. **`npm run seed` referă un fișier inexistent** (`scripts/seed.ts`).
15. **Un artefact de dovadă e gol** — `evidence/knowledge/fs-diff-disabled.txt`, 0 octeți. Vidul e prin construcție dovada, dar e indistinct de o captură eșuată și nu există atestare separată.

## C. Arhitectură și nomenclatură

16. **Trei orchestratoare, 891 de linii, același nume de bază** — `src/orchestrator.ts` (156), `src/decision-loop/orchestrator.ts` (351), `src/model-exchange/orchestrator.ts` (384). Toate trei referite, deci niciunul mort, dar limita de responsabilitate nu e documentată nicăieri.
17. **Două suprafețe HTTP paralele cu stiluri opuse** — `/api/runtime` servit de un singur fișier de 1.220 de linii, `/api/v1` de cinci fișiere însumând 734. Montate una lângă alta, fără document care să spună ce cerere aparține cărei suprafețe.
18. **Coliziune de nomenclatură „router"** — strat HTTP vs. motor de selecție de model vs. moștenire, în același arbore. Similar „gateway" (plan de guvernanță vs. adaptor de provider) și „work-ledger" (două implementări, 517 linii cumulat).
19. **Coliziuni de nume de bază în `src/`:** `index.ts` ×12, `types.ts` ×4, `registry.ts` ×4, `policy.ts` ×3, `orchestrator.ts` ×3, `config.ts` ×3.
20. **Cinci fișiere `docker-compose*.yml` fără document de departajare.** `release.yml` împachetează doar `docker-compose.yml`, deci configurația de automatizare — 280 de linii, cea mai recent modificată — **nu ajunge în artefactul de release.**
21. **Cinci descrieri de arhitectură concurente** coexistă în `docs/`.

## D. Documentație și versionare

22. **`CHANGELOG.md` declară istoricul închis la ~60 de commit-uri distanță de realitate** — secțiunea `[Unreleased]` spune literal „No changes are pending". Ultima atingere: 3 august.
23. **Versionarea nu are sursă unică de adevăr.** `package.json` → `2.0.0-build-week`; `RELEASE_MANIFEST.md` → `0.4.0-core-active`; ultima etichetă → `v0.5.0-20260819`; cea mai mare etichetă → `v2.1.0-baseline`. **Numerotarea scade în timp** (`v2.1.0` pe 1 aug → `v0.4.0` pe 3 aug). `generate-checksums.sh` citește din `package.json`, deci artefactele purtă eticheta seriei abandonate.
24. **`RELEASE_MANIFEST.md` fixează un „Release commit" diferit de commit-ul etichetei pe care o descrie.** Manifestul nu e verificabil.
25. **43 din 47 de documente `.md` sunt stagnante** (neatinse din 11 august sau mai devreme). `README.md` (2 august) nu menționează nicio capabilitate din ultimele trei săptămâni.
26. **Întreg dosarul de dovezi atestă o stare de acum trei săptămâni** — toate cele 21 de artefacte din `evidence/knowledge/`, inclusiv `sbom.json` (2.236 linii), comise 2 august. `SBOM.json` și `checksums.sha256` nu mai corespund arborelui actual.
27. **24 de ramuri remote pentru 167 de commit-uri, 22 dintre ele deja integrate.** `git branch -a` nu mai poate răspunde la „ce e în lucru".
28. **26 de fișiere de prototip arhivat și 1.647 de linii de briefuri sunt versionate ca documentație de proiect.** `docs/reference/model-exchange-v0.1-original/` e un al doilea proiect complet, cu propriul `package.json`, `render.yaml`, client React și server Express. Nu compilează, nu se testează, dar apare în orice generare de checksum.
29. **Personele de autor multiplică identitățile fără registru.** O persoană sub 5 nume și 3 adrese; AMB sub 3 nume și 3 adrese; `office@mayleven.com` folosită de ambele persone. **Nu există `.mailmap`.** Orice statistică de contribuție pe acest repo e greșită.
30. **Dovada de utilizare Codex cerută de regulament nu a fost completată** — placeholder-ul `[session ID from /feedback]` e încă în `DEVPOST_SUBMISSION.md:97`.

## E. Cele 8 defecte din activarea live

1. Perete de îndreptățire DigitalOcean Inference (catalog ≠ acces)
2. Antet de rutare Portkey — `model-egress-proxy.ts:57` forwardează doar authorization/accept/content-type; Portkey cere `x-portkey-config`
3. **Orbire a suitei de teste** — `tests/runtime/model-egress-proxy.test.ts` injectează `jest.fn()` în toate cele 4 cazuri; linia 47 are IP hardcodat
4. Proprietate dubioasă a worktree-ului (rezolvat cu `safe.directory`)
5. `automation-preflight.sh:25` — `git rev-parse --show-toplevel` fără `-C` sau `|| true`
6. Porturi publicate declarate fără reguli NAT
7. Buget de misiune hardcodat 120 s (= datoria 10)
8. `.git/index` deținut de root (rezolvat)

---

# PARTEA VII — Planul de ordonare

Nouă pași, în ordinea în care i-aș face. Șase sunt sub o oră.

## Imediat — securitate și trasabilitate

**Pasul 1 (10 minute) — închide Postgres.** `0.0.0.0:5432` → `127.0.0.1:5432` în compose-ul de pe DO, repornire container. Singura expunere publică reală din estate.

**Pasul 2 (30 minute) — restaurează trasabilitatea codului desfășurat.** `/opt/ronor-governance/app_k9` (Hetzner) nu are git; `/opt/ronor` are git fără remote. Fie le pui sub git cu remote corect, fie le reconstruiești din `main`. Până atunci nu poți răspunde la „ce rulează în producție".

**Pasul 3 (15 minute) — mapează bastionul.** `100.77.197.28` refuză cheia de pe Hetzner. Un nod în tailnet la care nu ai acces e un necunoscut, nu o datorie.

## Săptămâna aceasta — coerență

**Pasul 4 (30 minute) — demontează ruta simulată.** Scoate `/api/v1/model-exchange` din `src/index.ts:249-251`. Elimină singurul risc reputațional direct: un apelant care primește text simulat marcat ca răspuns real.

**Pasul 5 (2–4 ore) — cablează `verified_confidence`.** Singura verigă care blochează pilotul OSaaS și termenul de 30 septembrie. Registrul de valoare există deja; lipsește doar măsurarea.

**Pasul 6 (1 oră) — o singură sursă de versiune.** Alege seria (recomand să continui de la `v0.5.0`), aliniază `package.json`, `RELEASE_MANIFEST.md` și eticheta, apoi etichetează `main` și lasă `release.yml` să ruleze o dată.

**Pasul 7 (1 oră) — curăță semnalul din git.** Șterge cele 22 de ramuri remote deja integrate și cele 2 instantanee pre-squash. Sincronizează ramura locală `main`. Adaugă `.mailmap` cu cele 10 identități mapate pe 2 persone.

## Următoarele două săptămâni — control

**Pasul 8 (1–2 zile) — adu execuția neguvernată sub poartă.** `ronor-tools-gateway` (`execute_shell`, `execute_on_contabo`) și `ronor-pool.service` (agenți autonomi ca root) sunt cea mai mare inconsistență dintre ce ai construit și ce protejezi. Ai deja pașapoartele de agent, poarta MI9 și lanțul de audit — doar nu sunt conectate la sistemele care execută.

**Pasul 9 (1 zi) — o singură hartă a estate-ului, versionată.** Un fișier în repo care listează: 4 gazde, ce rulează pe fiecare, din ce revizie, cu ce expunere. Singura hartă existentă acum e `INFRA_NOTES.md` din 5 august, pe o gazdă, în afara git-ului. Actualizează în același pas `CHANGELOG.md` și roadmap-ul — o dată, complet.

## Ce NU aș face acum

- **Nu aș desfășura runtime-ul de generația a treia** înainte de pașii 1–4. Este cel mai bun cod pe care îl ai; merită o desfășurare curată, nu una peste trei generații confuze.
- **Nu aș atinge planurile Python.** Funcționează, au date reale, 11 zile de uptime. Sunt netestate și nedocumentate, dar sunt singura parte care face muncă utilă chiar acum.
- **Nu aș rescrie nimic pentru eleganță.** Cele 30 de datorii de mai sus sunt toate de contabilitate, nu de arhitectură. Arhitectura e sănătoasă.

---

# Ce a rămas nemapat

Onestitate asupra limitelor acestui audit:

1. **`do-bastion-agent`** — online în tailnet, SSH refuzat pe cheie de pe Hetzner. Complet necunoscut.
2. **Contabo în detaliu** — am confirmat Ollama, cele 11 modele, absența GPU-ului și uptime-ul, dar nu inventarul de containere și `/opt`. Puntea către laptop a căzut în timpul sondării.
3. **Conturile OpenAI și cele trei proiecte** — nu sunt verificabile din infrastructură. Cheile există în `.env.production`, dar consolele de vendor nu se accesează de pe IP rusesc, conform propriei tale reguli. Dacă vrei corelarea chei ↔ proiecte, se face din consola OpenAI, de pe altă rută.
4. **Providerii Anthropic, Gemini, DeepSeek, Perplexity, OpenAI, Kimi, xAI** — chei prezente, netestate live în acest audit. Doar Qwen, Ollama și DO Inference au fost verificate prin apel real.

---

*Audit realizat 24–25 august 2026. Toate cifrele măsurate prin sondare live și citire de cod. Nicio valoare de secret afișată. Zero merge, push, release sau deploy.*
