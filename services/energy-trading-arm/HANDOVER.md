# Handover — Energy Trading Prototype (Muse → RONOR porting team)

- **From:** Muse (Cursor cloud agent, energy-trading prototype workspace)
- **To:** RONOR porting team, via Liviu
- **Date:** 2026-09-14
- **Prototype version:** 0.2.0 (`pyproject.toml`)
- **Status:** working prototype, 127 tests green, `ruff` clean. Delivered as-is, no new building for this handover.
- **Production note:** this VM (`/agent`) is my dev workspace. It is **not** part of the production delivery chain and never holds production secrets: no `.env` file exists here, no bot tokens, no API keys. The package contains zero secret values (verified by scan; see §0). After handover the VM stays as dev sandbox.

Contents of this document (mirrors the 6 requested sections):

1. [Source code](#1-source-code-complete)
2. [Endpoint contracts](#2-endpoint-contracts)
3. [Reasoning layer](#3-reasoning-layer)
4. [Data model](#4-data-model)
5. [Decision log](#5-decision-log)
6. [Learnings](#6-learnings-short-note)

Companion tarball: `dist/energy-trading-handover-2026-09-14.tar.gz` (same content as this workspace minus caches/ephemera; file list in §0).

## 0. What is (and is not) in the package

Included: `src/`, `tests/`, `templates/`, `docs/`, `ronor/`, `static/`, `deploy/`, `README.md`, `pyproject.toml`, `requirements.txt`, `requirements-pinned.txt`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `start.sh`, this file, live `data/*.csv` (Sep 2026 operational inputs), decision-log slice of `state/` (`claims.json`, `pnl_twin.jsonl`, `jobs.jsonl`, `book.json`, `ingest.jsonl`, `briefs/`).

Excluded: `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`, `*.egg-info/`, ephemeral runtime files (`state/heartbeat.json`, `state/watch.json`, `state/last_run.json`, `state/alerts.jsonl` — bulk alert history, regenerable).

Privacy note: `state/ingest.jsonl` contains Telegram `chat_id`s (incl. the operator's private chat) and sender display names — operator identity is by design part of the audit trail. No message *content* beyond file names / 80-char prefixes. No bot tokens anywhere.

Runtime when captured: Python 3.12.3. Pinned deps (`requirements-pinned.txt`):

```text
fastapi==0.141.1
uvicorn==0.52.4
pydantic==2.13.5
pandas==3.0.5
numpy==2.4.4
openpyxl==3.1.5
python-multipart==0.0.9
pytest==8.8.2
httpx==0.28.1
ruff==0.14.2
```

(`requirements.txt` / `pyproject.toml` carry the compatible-release floors: `fastapi>=0.110`, `uvicorn[standard]>=0.29`, `pydantic>=2.6`, `pandas>=2.0`, `numpy>=1.26`, `openpyxl>=3.1`, `python-multipart>=0.0.9`.)

Run: `cp .env.example .env && docker compose up -d --build`, or `ET_SCHEDULER_ENABLED=true python3 -m uvicorn energy_trading.api:app --host 0.0.0.0 --port 8000`. Tests: `python3 -m pytest -q` (127 passed at handover). Lint: `python3 -m ruff check src tests && python3 -m ruff format --check src tests`.

---

## 1. Source code (complete)

Entry point: `src/energy_trading/api.py` — FastAPI app `energy_trading.api:app`, uvicorn on port 8000.

Module inventory (`src/energy_trading/`, one line each):

```text
api.py            FastAPI service: all /api/* endpoints, lifespan, module wiring
agent.py          CrossBorderAgent: run_day / run_from_prices, book, nominate, settle
arbitrage.py      Spread math: evaluate_border, find_opportunities, directional availability
twin_pnl.py       P/L Digital Twin: operator vs twin vs perfect, reported-vs-computed gap
sources.py        Market publishers: OPCOM PZU (RO), OREE DAM + NBU rate (UA), merge/provenance
scheduler.py      24/7 JobRunner: watch/fetch/pnl/hub_run/weather/evening/settle/gate/heartbeat/retry
operator_bot.py   Deterministic RO/EN operator brain: commands, intents, knowledge base
ronor_agent.py    Ollama tool-calling loop over capabilities + SYSTEM + guardrails
capabilities.py   THE tool registry: 21 Tools, single source for Ollama/MCP/tools.json
telegram_bot.py   TelegramIngestor: webhook intake (.xlsx/.csv/text/commands) → store + bids file
ops_intake.py     Parsers: Excel/CSV/text → OpsIntake; bids CSV read/merge/write
market_data.py    Providers: SimulatedProvider, OverrideProvider, CSV-backed
models.py         Trade, PricePoint, DecisionLog, Market
interconnectors.py  20 interconnectors (id, zones, TSO, tariff, loss, coupling) + corridor_ic()
risk.py           Position/notional/VaR/concentration limits, REMIT flags
settlement.py     Settlement lines for delivered hours
sovereignty.py    ClaimsRegister, evidence levels, sovereignty balances
alerts.py         Threshold rules (concentration, basis, thin CBC, worker errors)
weather.py        Open-Meteo workers: 6 countries → demand/wind/solar signals
hub.py            RO-as-hub snapshot: basis vs neighbours, wheeling top
store.py          File-backed JSON/JSONL StateStore (state/)
config.py         Settings from env (12-factor, .env.example documents all)
mcp_server.py     MCP stdio server exposing the 21 tools to other node agents
```

Import graph (who pulls whom;(dataclasses omitted):

```text
api.py → agent, config, hub, interconnectors, market_data, operator_bot,
         ops_intake, ronor_agent, scheduler, sovereignty, store, telegram_bot, weather
scheduler.py → agent, arbitrage, config, hub, market_data, ops_intake (load_bids_csv/load_ntc_csv),
               sovereignty (claims), sources (FETCHERS), store, twin_pnl, weather
operator_bot.py → agent, config, interconnectors, ops_intake (load_ntc_csv), scheduler (JobRunner helpers), store
ronor_agent.py → capabilities (BY_NAME, describe, openai_tools, to_command)
telegram_bot.py → config, ops_intake (parse_daily_note, read_table_ops, write_bids_csv), store
ops_intake.py → interconnectors (REGISTRY, corridor_ic, normalize_border), market_data, models
arbitrage.py / twin_pnl.py → interconnectors, models
capabilities.py → (nothing internal; pure registry)
mcp_server.py → capabilities + HTTP client to the service (ET_API_URL/ET_API_TOKEN)
ronor/dispatcher_plugin.py → stdlib only; HTTP to /api/ops-upload + /api/ronor|/api/operator
```

Config / secrets schema (values redacted — see `.env.example`, no values ship):

```text
ET_SCHEDULER_ENABLED, ET_TIMEZONE, ET_HOME_ZONE, ET_DATA_DIR, ET_STATE_DIR
ET_WEATHER_HOUR, ET_HUB_RUN_HOUR, ET_EVENING_HOUR
ET_WATCH_MINUTES, ET_SETTLE_MINUTES, ET_GATE_CLOSURE, ET_GATE_REMINDERS,
ET_RETRY_MINUTES, ET_MAX_RETRIES, ET_HEARTBEAT_MINUTES
ET_FETCH_MINUTES, ET_PNL_HOUR
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_CHATS
ET_API_TOKEN (→ X-RONOR-Token header), ET_PUBLIC_URL
OLLAMA_URL, OLLAMA_MODEL (=ronor-energy after ronor/install.sh), OLLAMA_TIMEOUT
ET_ALERT_CONCENTRATION, ET_ALERT_BASIS_EUR, ET_ALERT_MIN_ATC_MWHH (see config.py for exact names)
```

Auth model (matches your RBAC finding): `TELEGRAM_ALLOWED_CHATS` is binary (no per-user roles anywhere in this codebase); machine endpoints guarded by `X-RONOR-Token` iff `ET_API_TOKEN` set, else open (dev only); `/api/jobs/*` and `/api/reset` have no own auth — must sit behind tailnet/reverse-proxy, only `/api/telegram/webhook` is safe to expose (secret-header checked, 403 otherwise).

---

## 2. Endpoint contracts

Full route table (`api.py`):

```text
GET  /api/health                 liveness + scheduler/telegram/ollama flags
GET  /api/interconnectors        20 interconnectors with TSO/tariff/loss
POST /api/run                    run agent on a day (RunRequest)
GET  /api/book                   book + summary
POST /api/nominate               nominate trade ids (human decision)
POST /api/settle                 settle delivered nominated trades
POST /api/ops-parse               parse free-text ops note → OpsIntake
POST /api/ops-upload              upload .xlsx/.csv → intake + bids file + reply   [X-RONOR-Token]
GET  /api/claims                 claims register (evidence layer)
GET  /api/sovereignty            RO balance, import dependence, energy/carbon
POST /api/hub                    hub snapshot for a day
GET  /api/weather                weather brief
GET  /api/jobs                   scheduler status + next runs
POST /api/jobs/tick              force one 24/7 loop pass
POST /api/jobs/{name}?day=       run one job (hub_run/fetch/pnl/watch/…)
GET  /api/alerts                 alert history
GET  /api/briefs                 stored brief files
GET  /api/ingest-log             ingestion audit trail
POST /api/telegram/webhook       Telegram updates (secret-header checked)
POST /api/telegram/set-webhook?public_url=  register webhook + bot command menu
POST /api/operator               deterministic brain over HTTP                  [X-RONOR-Token]
POST /api/ronor                  Ollama tool-calling brain over HTTP            [X-RONOR-Token]
GET  /api/day?day=&refresh=      one-day operator view (brief/pending/nominated/evidence)
POST /api/reset                  clear book+claims (dev; unauthenticated — do not expose)
```

### 2a. `POST /api/ronor` (text input)

Request (`OperatorAsk`):

```json
{ "text": "cât am făcut ieri?", "chat_id": "-100123", "who": "Natalia" }
```

- `text`: slash command (`/pl 13.09`), ops note, or free question, RO/EN.
- `who`: human identity → written into audit (`nominated_by`, claims). HTTP callers behind `tailscale serve` get it from `Tailscale-User-Login` headers automatically.

Response:

```json
{ "text": "cât am făcut ieri?", "who": "Natalia", "reply": "📊 P/L Digital Twin — …", "kind": "command", "accepted": true }
```

- `kind`: `command | text | question | ignored` (`ignored` + empty reply = "not energy, leave to another module").
- Flow: route-first — ops notes and clear intents execute deterministically **without consulting the model**; the rest goes to the Ollama loop (max 4 rounds), any Ollama failure degrades to the deterministic brain (never silent).

Latency: deterministic path = milliseconds; with Ollama = model-bound (timeout `max(OLLAMA_TIMEOUT,120s)`). In this prototype `OLLAMA_URL` was **empty**, so `/api/ronor ≡ /api/operator` always (see `/api/health → ronor_brain.ollama: false`).

Errors: `401` bad/missing `X-RONOR-Token` (only when `ET_API_TOKEN` set); `422` malformed JSON.

### 2b. `POST /api/ops-upload` (xlsx input)

```bash
curl -X POST "http://host:8000/api/ops-upload?day=2026-09-14&apply=true&source=ronor" \
  -H "X-RONOR-Token: <ET_API_TOKEN>" \
  -F "file=@operatiuni_14.09.xlsx"
```

- Query: `day` ISO (required semantics; validated, 400 otherwise), `apply=true` (default: parse → write day overrides + merge `data/bids_<day>.csv` → watch reruns), `source` (audit label).
- Accepts `.xlsx/.xlsm/.csv` ≤ 10 MB (400 otherwise). CSV delimiter auto-detected (`,`/`;`/tab), UTF-8-SIG.
- Response: full `OpsIntake` (`day, availability, prices_override, bids{capacity,cbc,limits,filled,realized}, decisions, unassigned_prices, warnings`) **plus `reply`** (human-readable summary for the dispatcher to relay). Re-posting an identical sheet changes nothing (merge is idempotent; watch uses content hashes).

XLSX column schema parsed (§4 has full detail): group headers `Capacity won | CBC Price | Bid Limit Price | Nominated MW | Profit EUR` (+ `Ro Price`/`Ua Price` optional), sub-header corridor row (`Ua - Md | Md - Ro | Ro - Ua | Ua - Ro | Transfer`), body rows `interval CET 1–24`; monthly summary layout (`AZI Import/Export | TOTAL`) → per-day `realized` rows.

Normalizations: European number formats (`1.250,5` → 1250.5, `0,23`, `€`, `-7,35 €`); corridor labels (`Ua - Md`, `Md/Ro`, `Transfer` → `UA-MD-RO`); "nominated 15 MW" inside note text → fill; summary `group+leg` pairs (`Ua-Md` group + `Md-Ro` leg → transit `UA-MD-RO`); day-total rows stored as `hour_cet=day`.

### 2c. `GET /api/health` (+ others)

Live-captured at handover (200, ~ms):

```json
{"status": "ok", "time": "2026-09-14T05:07:38.433131+00:00",
 "zones": ["AT","BE","BG","CH","DE-LU","DK1","ES","FR","GB","HU","IT-N","MD","NL","NO2","PL","RO","RS","UA"],
 "scheduler": false, "heartbeat": "2026-09-14T08:06:51.444891+03:00",
 "telegram": false, "ronor_brain": {"ollama": false, "model": "qwen2.5"}}
```

(`scheduler:false` here = TestClient without lifespan; production runs with `ET_SCHEDULER_ENABLED=true`. `telegram:false` = no token configured on this VM — expected.)

Error modes across the API: `400` invalid day / non-Excel upload / >10 MB; `401` bad `X-RONOR-Token`; `403` bad `X-Telegram-Bot-Api-Secret-Token`; `404` unknown job name.

---

## 3. Reasoning layer

### 3a. System prompt (exact, `ronor_agent.py:SYSTEM`)

```text
Ești RONOR, nodul suveran de inteligență artificială. Vorbești cu operatorul uman al
operațiunilor de tranzacționare transfrontalieră a energiei electrice (RO/UA/MD, România ca hub
regional). Răspunzi în română, scurt, ca un coleg de birou care știe ce face.

Reguli absolute:
1. Orice cifră (preț, MW, MWh, euro, ore, capacitate) vine dintr-o unealtă. Nu inventezi și nu
   estimezi. Dacă nu ai apelat unealta, nu ai cifra.
2. Nu nominalizezi și nu recomanzi nominalizări din proprie inițiativă. Unealta `autorizeaza` se
   apelează doar când operatorul spune explicit că autorizează / confirmă / nominalizează.
3. Pentru 'cum stă ziua', 'ce facem azi', 'mâine' → apelezi întâi `ziua`. Pentru capacități →
   `capacitate`. Pentru 'ce am de confirmat' → `de_autorizat`.
4. Dacă operatorul lipește un tabel, prețuri pe intervale sau o decizie ('skip UA-MD') → `noteaza`
   cu textul exact.
5. Când o unealtă răspunde, redă-i conținutul fidel (poți scurta, nu poți schimba cifre) și adaugă
   cel mult o propoziție de context. Nu repeta întrebarea.
6. Dacă nu știi sau uneltele nu acoperă întrebarea, spui asta direct.

Unelte disponibile:
<describe() — the 21-tool list from capabilities.py, injected here>
```

Deterministic layer (no model): `operator_bot.py` — Romanian intent matcher +slash commands (`/azi /maine /pl /autorizez /hub /ntc /meteo /book …`, bot-suffixed `/hub@Bot` forms, `azi/mâine/dd.mm` day args) + grounded `KnowledgeBase` over `README.md`, `docs/SOVEREIGNTY_DOCTRINE.md`, `deploy/README.md` (keyword-overlap retrieval; "don't know" when nothing matches). `_route_for_ronor` (`api.py`): ops-looking text → intake verbatim; recognized intent → deterministic command; rest → model.

### 3b. Models called — correction to an assumption

- **Ollama only** (`OLLAMA_URL`, default model `qwen2.5`; `ronor/install.sh` bakes doctrine into a `ronor-energy` model via `/api/create`). Tested-suitable per local notes: `qwen2.5` (fast), `qwen3.5`/`llama3.1` (reasoning); `deepseek-r1` too slow for chat.
- **No Portkey. No direct provider calls.** Anything external goes through Ollama or not at all. If you want Qwen-Max-via-Portkey as primary, that is new code on your side.
- In this prototype Ollama was never wired (`OLLAMA_URL` empty) — all reasoning behavior observed came from the deterministic layer.

### 3c. Few-shot examples

**None.** No few-shot blocks exist anywhere in prompts. Behavior comes from rules + tool outputs + tests.

### 3d. Tools / function calls (21, `capabilities.py:TOOLS`)

Mutating tools (`propuneri, autorizeaza, deconteaza, activeaza, opreste, noteaza`) execute only on explicit operator intent, whatever the model decides; `autorizeaza` additionally requires the XB-ids (or "tot") to appear in the human's own text. Grounding: every number in the final reply must occur in some tool output (`numbers_grounded`), else the raw tool output is returned. Loop bounded at 4 rounds.

```text
ziua, capacitate, hub, meteo, granite, propuneri*, de_autorizat, autorizeaza*,
book, deconteaza*, pl, preturi, status, alerte, suveranitate, registru,
doctrina, intreaba, activeaza*, opreste*, noteaza*   (* = mutates)
```

Full Romanian descriptions + JSON schemas: `capabilities.py`, `ronor/tools.json`, and live via `openai_tools()` (OpenAI function-calling format) / MCP stdio (`python -m energy_trading.mcp_server`, read-only hints, identity in `_meta.who`).

---

## 4. Data model

### 4a. XLSX structures accepted (all three detected per-sheet, mixed workbooks OK)

1. **Operator position table** (the daily sheet): merged group header row
   (`Capacity won | CBC Price | Bid Limit Price | Nominated MW | Profit EUR`, + optional `Ro Price | Ua Price`),
   corridor sub-header (`Ua - Md | Md - Ro | Ro - Ua | Ua - Ro | Transfer`), body `Intervals CET 1–24` with MW/EUR per corridor×interval; trailing `Total` rows skipped; unknown sheets (`Cum se completeaza`, notes) skipped silently.
2. **Monthly Import/Export summary**: `AZI Import/Export | TOTAL Import/Export` with `MW | Profit` legs, merged group cells (`Ua - Ro 420 | Ua - Ro …`, transit read as group+leg) → per-day `realized` figures.
3. **Market side**: hour-matrix (zones × 0–23), `Granita/ATC_MW` border tables, `Zona/Ora/Pret` price tables, free-form text rows (`RO-UA ATC 450 MW`, `UA ora 18 pret 68`).
4. Canonical template: `templates/operatiuni_zilnice_template.xlsx` (generator: `templates/make_template.py`).

### 4b. Internal representation

`OpsIntake`: `day`, `availability{border: MW}`, `prices_override{zone: {hour0-23: €/MWh}}`, `bids{capacity,cbc,limits,filled,realized: {corridor: {hour: value}}}` (day-totals at pseudo-hour `-1`), `decisions[]`, `unassigned_prices`, `warnings[]`. First-value-wins on price conflicts (explicit beats bulk).

Canonical files: `data/ntc_YYYY-MM-DD.csv` (directional hourly NTC, `hour_cet` 1–24 + `*_value` columns); `data/prices_*.csv` (`hour_cet,ro_dam_eur,ua_dam_eur,md_price_eur`); `data/bids_*.csv` (`delivery_day,corridor,hour_cet,capacity_mw,cbc_price_eur_mwh,bid_limit_eur_mwh,filled_mw,realized_eur,note`; `hour_cet=day` = day-total row).

Core structs: `Trade` (`trade_id XB-NNNN`, `interconnector_id`, `from/to_zone`, `delivery_start`, `volume_mw`, `expected_net_eur`, `status proposed|nominated|settled`, `nominated_by/at`, evidence ref); `PricePoint(zone, delivery_start, price_eur_mwh)`; `DecisionLog`; `Opportunity(spread_net, …)`.

### 4c. Outputs produced

- One-message day brief (`daily_brief`): real/simulated prices, NTC state, proposals with XB-ids, bid limits when one leg unpriced, gate reminders.
- Bid limits per corridor×interval (buy-below / sell-above with known-leg price + model limit + operator limit).
- P/L Digital Twin report (`format_pnl`): per-corridor `prins Xh din Yh pozitive · real € · ideal € · ratat · twin € · raportat €`, day totals (`operator/own-costs/twin/perfect/reported/reported_gap`, capture %), month-to-date. Units: MW, MWh, EUR/MWh, EUR, CET intervals 1–24.
- Provenance: `state/briefs/<day>_sources.json` (exchange, URL, fetched_at, hours, `verified_typed` for hand-typed values).

---

## 5. Decision log

What the prototype recommended, on what inputs (all included in tarball under `state/`):

- `claims.json` (2 entries): sovereignty recap + `pnl_twin` claim for 2026-09-13 (`operator nedeterminat, twin €0, ideal €30,863`, evidence `market_published`, ref `briefs/2026-09-13_pnl`).
- `pnl_twin.jsonl` (6 rows, 2026-09-12/13): twin/perfect/reported per run — shows the calibration arc (early run booked operator −787.2 from limits, later runs undetermined once fill-evidence rules tightened; twin €16,247 on one 13.09 run vs perfect €30,863).
- `briefs/` (~100 files): per-day `_result.json` (input state: prices/NTC used, won capacity, decisions, hub summary, alerts), `_pnl.json` (full twin computation incl. per-hour rows), `_sources.json`, `_overrides.json`, plus `ingest_*` snapshots of every parsed upload.
- `jobs.jsonl`: every job run (name/day/status/seconds) — the execution trail.
- `book.json`: `[]` — **no live nominations were ever executed through the prototype**; everything stayed `proposed` (paper). Nominations remained a human act by design (`/nomineaza` → `nominated_by`).
- `ingest.jsonl`: who-sent-what (chat_id, kind, day, MW/price counts, warnings).

Feedback loops already in the code (port these, don't rediscover them): `reported_gap` (operator-booked vs model-computed per day — the calibration signal); `implied_cost_models` (linear fit of operator bid limits → implied all-in cost); fetch-time verification of hand-typed prices against OPCOM/OREE with mismatch logging.

---

## 6. Learnings — short note

**What worked well.** Deterministic-first + LLM-optional: the system was useful with zero model wired, and the model can only narrow (never widen) what executes. Content-hash `watch` (≤1 min rerun on real change, silent on identical re-posts). Twin accounting with explicit `unknown_hours` (unpriced leg → undetermined, never zero) — this one decision prevented most false P/L. `reported` vs computed gap as a first-class calibration metric. Merging morning position + evening results into one `bids_<day>.csv` (idempotent).

**What I would redesign fresh in RONOR.** File-backed JSONL → Postgres at day one (we outgrew `state/` at ~100 briefs; concurrent writers would collide). Real ENTSO-E Transparency API with token instead of OPCOM/OREE HTML scraping (scrapers break on markup changes; OREE table needed dynamic header detection). Per-user roles from the start (this codebase has none — matches your finding). Auth on every endpoint (here `/api/jobs/*`, `/api/reset` are open and rely on network perimeter).

**Which markets/products first.** RO→UA export spreads and UA→RO-via-MD transit showed the largest measured edge (twin €16k/day-scale on 13.09 test data, transit 15 MW × ~€100+/MWh spreads on 14.09); do those two corridors first. MD legs are blocked on a missing MD price feed (still operator-provided) — that feed is the highest-leverage data dependency. Day-ahead only; intraday (XBID) needs a second engine (no ID logic exists here).

**Non-obvious market/regulatory subtleties hit.** SDAC gate 12:00 CET = 13:00 Bucharest (reminders keyed to that). OREE publishes in Kyiv time → CET shift matters (hour 24 needs *next* day's file). UAH→EUR at the **NBU D-1 auction-day rate**, not spot. OPCOM 15-min → hourly averaging differs ±0.01 from published hourly values (we verified against the operator's sheet). CBC is sunk per held hour (paid filled or not — the twin deducts it once). Transit capacity is strictly directional (a forward-hold implies nothing about reverse). UA DAM hour-24 gap and MD price absence must render as "unknown", never interpolated.

---

*End of handover. Questions on any section → Liviu relays; I answer against the code above, which is the single source of truth for prototype behavior.*
