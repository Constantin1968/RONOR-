# RONOR — Infrastructura existentă, capabilitățile reale, și cine a schimbat ce

**Data auditului:** 25 august 2026, 03:00–04:00 EEST
**Metodă:** sondare live a gazdelor prin Tailscale, citire directă a codului sursă la revizia `44f3798`, analiză de paternitate pe toate cele 164 de commit-uri.
**Ce NU este acest document:** o repovestire a documentației. Fiecare cifră de mai jos a fost măsurată, nu citată.

---

## Sinteza în șase propoziții

RONOR nu este un proiect, ci **trei generații de sisteme care rulează simultan** pe aceeași infrastructură. Estatea live este cu un ordin de mărime mai mare decât sugerează repo-ul: **55 de containere active**, 7 rețele izolate, 7 noduri în mesh, pe 4 gazde. Planurile R-* despre care documentația spune „roadmap" **rulează de 11 zile ca servicii Python funcționale** — cu SMTP, IMAP, Telegram, Qdrant și Temporal conectate. Runtime-ul TypeScript de generația a doua (13.114 linii) este cea mai avansată piesă și conține zero simulare — dar **nu este desfășurat**; containerul de guvernanță rulează cod din 9 august etichetat `2.0.0-build-week`. Utilizatorul a scris personal întreg runtime-ul de generația a doua (69 de commit-uri); AMB a scris stratul de cunoaștere (6.003 linii). Golul real nu este de capabilitate, ci de **coerență**: prea multe sisteme funcționale care nu se cunosc între ele.

---

## Partea I — Infrastructura existentă

### 1. Mesh-ul: 7 noduri, 4 gazde reale

| Nod Tailscale | IP | Sistem | Rol | Stare |
|---|---|---|---|---|
| `ronor-hetzner` | 100.83.241.57 | Linux | **gazda principală** — 55 containere | activ, uptime 1 săpt. 4 zile |
| `ronor-runtime` | 100.124.123.90 | Linux | a doua gazdă Hetzner (IPv6 `2a03:b0c0:3:f0`) | activ, trafic greu: 57 MB tx / 42 MB rx |
| `do-bastion-agent` | 100.77.197.28 | Linux | bastion DigitalOcean | prezent în mesh |
| `vmi3488431` | 100.87.14.42 | Linux | **Contabo** — Ollama, 11 modele locale | inactiv (964 B tx) |
| `desktop-eapcqug` | 100.108.229.28 | Windows | laptop de control | activ, releu „hel" |
| `iphone184` | 100.122.21.82 | iOS | client mobil | prezent |
| `iphone-se-gen-2` | 100.110.50.9 | iOS | client mobil | offline |

Observație importantă: **`ronor-runtime` mută 57 MB de trafic** și nu apare nicăieri în documentația canonică. Este a doua gazdă Hetzner, activă, cu conexiune directă IPv6. Nu am inventariat-o în acest audit — este primul gol de cunoaștere de închis.

### 2. Gazda principală — capacitate și postură de securitate

- 16 vCPU · RAM 30 G total, 9 G folosit, 20 G disponibil · disc 601 G, 111 G folosit, **466 G liber**
- kernel 5.15.0-187 · **Docker 29.7.1**
- IP public IPv6: `2a01:4f8:1c1a:3d4e::1`

**Firewall (ufw activ), singurele porturi deschise spre internet:**

| Port | Serviciu |
|---|---|
| 22/tcp | SSH |
| 80/tcp, 443/tcp | Caddy |
| 41641/udp | Tailscale |

Politica implicită este `-P INPUT DROP`. Toate porturile aplicațiilor sunt legate pe `127.0.0.1` și accesibile exclusiv prin mesh.

**O constatare de igienă, verificată și infirmată ca risc live:** două servicii Python ascultă pe `0.0.0.0` — `telemetry_aggregator.py` (:8401) și `pool_service.py` (:8402). Primul răspunde `HTTP 200 fără autentificare`. Am testat accesul din exterior pe IP-ul public: **HTTP 000, filtrat**. Deci ufw le blochează. Rămâne totuși o legare prea largă care depinde de o singură linie de apărare — de corectat la `127.0.0.1`, nu urgent.

### 3. Servicii în afara Docker (systemd)

Trei unități care nu apar în niciun `docker-compose` și nu sunt menționate în repo:

| Unitate | Descriere din systemd |
|---|---|
| `ronor-cc.service` | RONOR Command Center Dashboard |
| `ronor-pool.service` | **RONOR Worker Pool — agenți care execută sarcini autonom** |
| `ronor-telemetry.service` | RONOR Telemetry Aggregator + Dashboard |

`ronor-pool.service` merită atenție: este descris ca pool de agenți autonomi, rulează ca `root`, și nu este guvernat de niciunul dintre mecanismele de control implementate în runtime-ul TypeScript.

### 4. Cele 55 de containere, grupate pe stive

**a) Planurile R-* — Python/FastAPI, sondate live și funcționale**

Acesta este rezultatul care contrazice cel mai puternic documentația. Documentul canonic de reconciliere listează majoritatea planurilor drept parțiale sau de roadmap. Realitatea:

| Serviciu | Port | Răspuns la `/health` |
|---|---|---|
| `ronor-r-comms` | 8100 | `status: ok`, **`smtp_configured: true`, `imap_configured: true`, `telegram_configured: true`** |
| `ronor-r-memory` | 8101 | `status: ok`, **`qdrant_ok: true`**, colecție `ronor_memory` |
| `ronor-r-execute` | 8600 | `status: ok` |
| `ronor-r-monitor` | 8700 | `status: ok`, **7 verificări active** |
| `ronor-r-schedule` | 8800 | `status: ok`, **`temporal_connected: true`, `worker_running: true`, 4 programări active** |
| `ronor-tools-gateway` | 8400 | 6 unelte: `execute_on_contabo`, `execute_shell`, `health_check`, `query_cida`, `send_email`, `web_search` — plus un subset separat `read_tools` (separare de privilegii) |
| `ronor-orchestrator` | — | `python -u main.py`, imagine 2.0.0 |

Traduse în capabilități: sistemul **poate trimite e-mail, poate citi e-mail, poate trimite pe Telegram, poate căuta pe web, poate executa shell, poate executa pe Contabo, are memorie vectorială și rulează 4 programări în Temporal** — chiar acum, de 11 zile.

`ronor-tools-gateway` este piesa cu cel mai mare potențial de impact și cel mai mare risc: `execute_shell` plus `execute_on_contabo` într-un gateway de unelte înseamnă execuție arbitrară pe două gazde.

**b) Stiva de automatizare (generația a treia, construită ieri)**

Toate 7 sănătoase, **0 restarturi**, imagini construite 24 august 16:15–16:22:

`ronor-automation-{langgraph, openhands-bridge, openhands-agent, codex-verifier, victoria-assurance, model-egress-proxy, automation-evidence-runner}-1`

Worktree: `/srv/ronor/automation/worktree`, HEAD `44f3798`, ramura `automation/mission-001`, curat. Aceasta este singura stivă care rulează cod din repo-ul actual.

**c) Guvernanță (TypeScript — dar veche)**

`ronor-governance`, imagine `app-ronor:sovereign-embed`, `node dist/index.js`. Conținutul `package.json` din container: `ronor-model-exchange-governance-spine`, versiune **`2.0.0-build-week`**. Sursele din `/opt/ronor-governance/app_k9` **nu au git**. Deci: aplicația desfășurată este o copie desprinsă din era Build Week, cu ~16 zile și ~103 commit-uri în urmă față de `main`, fără trasabilitate la un commit.

**d) Cadre de agenți** — `ronor-langgraph` (:2024) + postgres + redis, `ronor-crewai` (:8500), `ronor-autogen` (:8085), `ronor-dify` (api :5001, web :3001, db, redis), `ronor-n8n` (:5678)

**e) Orchestrare** — `ronor-temporal` (1.29.7) + postgres + admin-tools + UI (:8233), `ronor-prefect` (:4200)

**f) Bariere de siguranță — trei sisteme independente** — `ronor-guardrails-ai` (:8900), `ronor-llm-guard` (:8902, imagine 9,08 GB), `ronor-nemo-guardrails` (:8901)

**g) Observabilitate** — stiva Langfuse completă (web, worker, clickhouse, postgres, redis, minio), `ronor-mlflow` (:5050)

**h) Cunoaștere / vectori** — `ronor-qdrant` (v1.19.0) + `ronor-qdrant-tls` (nginx)

**i) CIDA — arhitectură soră, activă** — `cida-api` (:8300), `cida-worker`, `cida-postgres` (17), `cida-minio`, `cidavault` — toate sănătoase, uptime 11 zile

**j) Poartă de modele** — `portkey-gateway` (:8787)

**k) Șase containere oprite, păstrate ca dovezi de rollback** — `ronor-governance-pre-constitutional`, `ronor-governance-prek9_080556`, `ronor-langgraph-old`, `ronor-orchestrator-broken-20260809` (ieșire 137), `ronor-orchestrator-prev-0149` (137), `ronor-telegram-gov`

### 5. Rețele — izolarea este reală

| Rețea | `internal` | Membri |
|---|---|---|
| `ronor-automation-control` | **true** | bridge, evidence-runner, victoria, langgraph, codex-verifier, openhands-agent |
| `ronor-model-egress` | **true** | model-egress-proxy, codex-verifier, openhands-agent |
| `ronor-model-uplink` | false | **doar** model-egress-proxy |
| `ronor-expansion` | false | 24 de membri |
| `ronor-planes` | false | 8 (planurile R-*, guvernanță, qdrant-tls) |
| `ronor-governance` | false | gov-redis, gov-postgres, tools-gateway |
| `ronor-shared` | false | n8n, dify-*, mlflow, openwebui, autogen, prefect |

Arhitectura de egress este corect construită: containerele de lucru sunt pe rețele `internal: true` fără rută spre internet; doar proxy-ul atinge `ronor-model-uplink`. Deny-by-default nu este o afirmație de document, este o proprietate verificată a rețelei.

### 6. Secrete — 13 fișiere

Toate în `/srv/ronor/automation/secrets/`, toate `mode 640`, proprietar `10001:10001` (utilizator non-root). Am confirmat doar lungimea și prefixul de hash, niciodată conținutul:

`assurance_receipt_public_key` (113 B) · `assurance_token` (64 B) · `automation_capability_key` (64 B) · `codex_api_key` (64 B) · `codex_receipt_private_key` (119 B) · `codex_verifier_token` (64 B) · `evidence_runner_token` (64 B) · `langgraph_token` (64 B) · `model_gateway_upstream_token` (117 B — cheia Qwen) · `openhands_bridge_token` (64 B) · `openhands_llm_api_key` (64 B) · `openhands_secret_key` (64 B) · `openhands_session_key` (64 B)

### 7. Furnizori de inteligență — stare reală

| Furnizor | Stare verificată |
|---|---|
| **Qwen / DashScope** | **Funcțional** la `dashscope-intl.aliyuncs.com/compatible-mode/v1` — 162 de modele. Endpoint-ul din China returnează 401. |
| **Contabo / Ollama** | **Funcțional**, sondat de pe Hetzner. `qwen3-coder:30b` (30,5 B, Q4_K_M, context 262.144, capabilități completion+tools), `qwen3.5:35b-a3b`, `deepseek-r1:70b`, `llama3.1:70b`, `qwen2.5:72b`, `bge-m3`. **Fără GPU** — 88 s până la primul token pe prompt mare. |
| **DigitalOcean Inference** | **Mort.** HTTP 403 cu cheie validă = eșec de îndreptățire, nu de rețea. |

### 8. Cronologia imaginilor — ce spune despre ritmul de lucru

Șapte imagini de guvernanță construite în 11 ore, pe 8–9 august:

`app-ronor:latest` (8 aug 22:02) → `pre-sovereign-20260809` → `sovereign` (9 aug 00:25) → `constitutional` (03:01) → `canon` (07:44) → `k9` (08:03) → `sovereign-embed` (09:10)

Progresia numelor — suveran, constituțional, canon — descrie o noapte de iterație pe modelul de guvernanță, nu pe funcționalitate.

---

## Partea II — Capabilitățile reale ale codului

Sursa: `src/runtime/`, 70 de fișiere, 13.114 linii, citite integral. Verificare la revizia `44f3798`: **56/56 suite de teste trec, 1.084/1.084 teste trec, `tsc --noEmit` 0 erori, 0 TODO, 0 FIXME, 0 „not implemented"** în 33.709 de linii de TypeScript.

### Verdictul pe subsisteme

| Subsistem | Verdict | Dovada |
|---|---|---|
| `providers/` (13 fișiere, 2.279 l) | **Real, integral. Nicio simulare.** | `grep -rn "simulated: true\|Math.random()" src/runtime` → **0 rezultate** |
| `router/` (6 fișiere, 1.435 l) | Real. 6 dimensiuni de scoring, 11 familii de reguli. | `scoring.ts:32-39`, `policy.ts:113-303` |
| `agents/` (5 fișiere, 2.218 l) | Real. Abstracție de lucrător digital cu pașapoarte. | `registry.ts:39-62` |
| `api/` (8 fișiere, 3.057 l) | Real. Pipeline în 9 etape, autentificare hash-uită. | `auth.ts:46-56` |
| `ledgers/` (3 fișiere, 750 l) | Real. Value Ledger există; „net verified gain" nu se calculează. | `schema.ts:103-122` vs. `pipeline.ts:358, 392` |
| `mission/store.ts` (491 l) | Real. Event sourcing, lanț hash, concurență optimistă. | `store.ts:267-324` |
| `automation/` (31 fișiere, 2.393 l) | Cod complet, **dezactivat implicit** — 9 precondiții. | `adapter-registry.ts:34, 49-51` |
| `management/` (158 l) | Real, dar declarativ. | `registry.ts:34-59` |

### Ce poate face concret

**Rutare de modele pe șase dimensiuni.** Formula: `Score = +Calitate − Cost − Latență − RiscOperațional + Suveranitate + Evidență`, cu ponderi 1,0 / 0,8 / 0,5 / 0,6 / 0,7 / 0,6. Calitatea este ponderată de telemetria observată (`quality_score * successRate`), nu de valoarea declarată în catalog. Catalogul are 24 de intrări, fiecare cu jurisdicție, nivel de suveranitate 0–3, fiabilitate a evidenței și risc operațional.

**Unsprezece familii de politici aplicate înainte de scoring** (P0–P9): prezența credențialului, doar-suveran, potrivire de capabilitate, determinist-mai-întâi, liste albe/negre de operator, plafon de latență **față de p50 calibrat, nu față de catalog**, plafon de cost, prag de evidență, filtrare jurisdicțională (setul UE include RO), obligativitatea căutării, și pin-ul de operator — care se aplică ultimul și **nu poate lărgi** setul admis. Fiecare respingere numește regula care a golit setul: refuzurile sunt explicabile.

**Nouă adaptoare de furnizor cu apeluri HTTP reale.** OpenAI, Anthropic (implementare nativă proprie, nu prin bibliotecă), Google, xAI, DeepSeek, Kimi, Perplexity, Ollama, plus un motor determinist local (parser shunting-yard, fără `eval`). Adaptarea per familie este reală: `gpt-/o1/o3/o4` primesc `max_completion_tokens`, `claude` primește buget de gândire, `gemini` primește effort.

**Calibrare care supraviețuiește repornirii.** Fereastră glisantă de 50 de eșantioane, minim 3, p50 calculat doar pe apeluri reușite, preîncărcat din Work Ledger la pornire.

**Lucrători digitali cu mandat.** Trei agenți — `researcher`, `analyst`, `evidence-curator` — fiecare cu pașaport care fixează mandatul, plafonul de confidențialitate (public/internal/restricted/sovereign), lista albă de unelte și pragul de evidență. Aplicarea listei albe este centralizată **în afara modelului**: modelul nu poate cere unelte. Delimitator anti-injection cu nonce per invocare. `analyst` este singurul cu confidențialitate `sovereign` — și, în consecință, singurul fără `web.fetch`.

**Autoritate și audit.** Chei SHA-256 cu `timingSafeEqual`, pipeline în 9 etape cu dry-run înaintea guvernanței, audit pe fiecare cale terminală, aprobări cu TTL de 15 minute și ștergere-înainte-de-execuție (protecție anti-replay).

**Țesătura de stare a misiunii.** 11 tipuri de evenimente, 6 actori, lanț SHA-256 pe JSON canonic, concurență optimistă tranzacțională prin `expectedVersion`, validare anti-secret și anti-prototype-pollution.

### Cele trei goluri reale în cod

1. **Modulul simulat vechi rămâne montat.** `src/model-exchange/engines.ts:131-158` conține `executeSimulatedProvider`; Mistral și Qwen sunt simulate necondiționat (`l.230-237`). Ruta e activă la `/api/v1/model-exchange` (`src/index.ts:249-251`). Un apelant pe calea veche primește text simulat. Risc reputațional, remediere de 30 de minute.
2. **„Net verified gain" nu se calculează.** `verified_confidence` este scris `null` pe calea de interogare (`pipeline.ts:358, 392`), `confidenceMeasured: false`. Aceasta este singura dependență reală a pilotului OSaaS.
3. **Runtime-ul de generația a doua nu este desfășurat.** Cea mai bună piesă de cod din estate rulează numai în teste.

---

## Partea III — Ce s-a schimbat, de ce, și de către cine

### Paternitatea, măsurată pe 164 de commit-uri

Toate identitățile se reduc la două persoane:

**Utilizatorul — 117 commit-uri**, sub cinci identități: `Constantine Liviu NITA <liviu.c.nita@gmail.com>` (88), `Merlin the Ancient Architect` (25), `Constantin Liviu NITA (Merlin) <merlin@ma11ai.com>` (2), `Constantin1968` (1), +1.

**AMB (Archeon Master the Best) — 47 commit-uri**, sub patru identități: `AMB ... COO <amb@mayleven.com>` (21), `AMB <amb@mayleven.com>` (16), `<office@mayleven.com>` (7), `<constantine@mayleven.com>` (3).

**Proprietatea pe module este netă:**

| Modul | Linii | Autor dominant |
|---|---|---|
| `src/runtime` | 13.114 | **Utilizatorul — 69 de commit-uri.** Întregul runtime de generația a doua. |
| `src/knowledge` | 6.003 | **AMB — 9 commit-uri** |
| `src/planes` | — | AMB (8) |
| `src/api` | — | AMB (3) |
| `src/model-exchange`, `governance`, `audit`, `decision-loop` | — | Utilizatorul, 1–2 commit-uri fiecare — **înghețate din iulie** |
| `src/sentinel` | — | Utilizatorul (1) |

### Cele cinci etape, și motivul fiecăreia

**1. 19–21 iulie — Build Week.** 3 commit-uri mari. Motiv: termen de concurs OpenAI Build Week. Livrat: rutare 6D, poarta MI9, lanț de audit SHA-256, scenariu BESS 20 MWh (OPCOM DAM + aFRR), UI web cu 3 tab-uri, submisie Devpost, script video. `1.0.0` → `2.0.0-build-week`, 43 de teste.

**2. 1–3 august — trei programe MIP, 40 de commit-uri.** Motiv: transformarea unui prototip de concurs în ceva operabil.
- **MIP-012**: infrastructură de inginerie — CI, workflow de release, checksums, 4 șabloane de issue, CODEOWNERS, docker-compose, CHANGELOG.
- **MIP-013 R-Sentinel**: 3 colectoare de telemetrie, ring buffer, prognozator, motor de alerte, degradare graduală.
- **MIP-014 R-Knowledge**: al 9-lea plan, **inert implicit** — activarea cere `KNOWLEDGE_ENABLED` exact `true`; starea dezactivată este observațional identică cu commit-ul `d058544d`. 14 câmpuri obligatorii, invarianți K-INV-1…7, 3 depozite vectoriale, scară de degradare reversibilă pe 4 niveluri.
- Rezultat `v0.4.0-core-active`: 23 de suite, 594 de teste.

**3. 5–9 august — desfășurarea infrastructurii (în afara repo-ului).** Motiv: nevoia de sistem care rulează, nu doar de cod care compilează. Aici au apărut planurile Python R-*, CIDA, Langfuse, Temporal, cele trei sisteme de bariere, Qdrant. Nimic din asta nu este urmărit în repo — de aceea nu apărea în auditul de cod. Cele șapte imagini de guvernanță din noaptea de 8–9 august aparțin acestei etape.

**4. 19 august — reconciliere, 16 commit-uri.** Motiv: exista un worktree cu muncă nepredată. PR #6 a consolidat: corecții de contabilitate MI9, providerul Kimi, rutare Telegram, configurație de producție sanitizată, invarianți de deploy, aprobări cu expirare + legare la cheia API + protecție anti-replay. PR #7 a corectat un fals-negativ în verificator. `v0.5.0-20260819`, 30 de suite, 891 de teste. Deliberat: fără apeluri live, fără deploy.

**5. 20–25 august — planul de automatizare guvernată, ~101 commit-uri.** Perioada cea mai intensă. Motiv: a face sistemul capabil să execute muncă de inginerie sub guvernanță. PR #9 granița de execuție guvernată, PR #10 ciclul de viață al rulărilor, PR #13/#14 egress deny-by-default, PR #16–#21 șase corecții OpenHands, PR #22 cale de audit izolată, PR #23 kit de activare versionat, PR #24 eliminarea SHA-ului hardcodat, PR #25 porturi de gazdă configurabile.

**Apoi, în noaptea de 24–25 august: prima activare live.** Rezultat: 8 defecte identificate, DigitalOcean confirmat mort, Qwen confirmat funcțional, agentul face muncă reală de inginerie — dar este tăiat la 120 de secunde.

### Arcul corpusului de teste

**43 → 594 → 891 → 1.084**

Aceasta este cifra care spune cel mai mult despre disciplină: creșterea testelor a urmat creșterea codului la fiecare etapă.

---

## Partea IV — Datoriile descoperite

### Datorii de coerență (cele mai grave)

1. **Trei generații rulează simultan fără să se cunoască.** Planurile Python (5–9 aug) execută munca. Guvernanța TypeScript (9 aug, `2.0.0-build-week`) o guvernează cu cod vechi. Runtime-ul de generația a doua (13.114 linii, cel mai bun) nu rulează deloc. Mecanismele de control cele mai avansate nu protejează sistemele care fac muncă reală.
2. **Cod desfășurat fără trasabilitate.** `/opt/ronor-governance/app_k9` nu are git. Nu se poate spune ce commit rulează în producție.
3. **`ronor-tools-gateway` are `execute_shell` și `execute_on_contabo`**, iar `ronor-pool.service` rulează agenți autonomi ca root — ambele în afara oricărei porți MI9.
4. **`ronor-runtime` (100.124.123.90) mută 57 MB și nu este documentat.**

### Datorii de documentație

5. **CHANGELOG oprit pe 3 august** — afirmă textual „No changes are pending", în timp ce ~103 commit-uri au aterizat după, inclusiv cel mai mare modul din repo.
6. **Versionare care merge înapoi:** `v2.1.0-baseline` (1 aug) → `v0.4.0-core-active` (3 aug) → `v0.5.0-20260819` (19 aug). `package.json` spune încă `2.0.0-build-week`.
7. **Roadmap vechi de 20 iulie** — coada P0 a fost executată sub alte nume, în alt modul, fără actualizarea planului.
8. **Cinci descrieri de arhitectură concurente** coexistă în `docs/`. Întrebarea dacă `src/orchestrator.ts` sau `src/model-exchange/orchestrator.ts` este autoritativ rămâne nerezolvată — ambele sunt cablate în `src/index.ts`.
9. **Wiki-ul de cunoaștere conține afirmații infirmate:** spune că eticheta v0.5.0 lipsește (există din 19 aug), că PR #24/#25 sunt în așteptare (ambele merge-uite pe 24 aug), și că ruta de model validată este DigitalOcean (infirmat).

### Cele 8 defecte din activarea live

1. Perete de îndreptățire DigitalOcean (catalog ≠ acces)
2. Antet de rutare Portkey — `model-egress-proxy.ts:57` forwardează doar authorization/accept/content-type; Portkey are nevoie de `x-portkey-config`
3. **Orbire a suitei de teste** — `tests/runtime/model-egress-proxy.test.ts` injectează `jest.fn()` în toate cele 4 cazuri; linia 47 are IP hardcodat
4. Proprietate dubioasă a worktree-ului (rezolvat cu `safe.directory`)
5. `automation-preflight.sh:25` — `git rev-parse --show-toplevel` fără `-C` sau `|| true`
6. Porturi publicate declarate fără reguli NAT
7. **Buget de misiune hardcodat la 120 s** — `maxPolls ?? 120` × `pollIntervalMs ?? 1000` în `services/openhands-bridge-server.ts`, necablat la mediu
8. `.git/index` deținut de root (rezolvat)

---

## Ce recomand, în ordine

1. **Cartografiază `ronor-runtime`.** O gazdă activă nedocumentată care mută 57 MB este un risc de necunoscut, nu o datorie de documentație.
2. **Restaurează trasabilitatea guvernanței desfășurate** — pune `/opt/ronor-governance/app_k9` sub git sau reconstruiește din `main`.
3. **Demontează ruta simulată** `/api/v1/model-exchange`. Cost mic, elimină singurul risc reputațional direct.
4. **Cablează măsurarea `verified_confidence`.** Este singura verigă care blochează pilotul OSaaS și termenul de 30 septembrie.
5. **Adu `ronor-tools-gateway` și `ronor-pool.service` sub poarta MI9.** Execuție arbitrară pe două gazde, fără guvernanță, este cel mai mare gol de control din estate.
6. **Actualizează CHANGELOG-ul și roadmap-ul o singură dată, complet.** 103 commit-uri nedocumentate transformă orice audit viitor în arheologie.

---

*Toate cifrele din acest document au fost măsurate pe 25 august 2026 prin sondare live și citire de cod. Conținutul secretelor nu a fost afișat niciodată — doar lungimea, permisiunile și prefixul de hash. Nu s-a executat niciun merge, push, release sau deploy.*
