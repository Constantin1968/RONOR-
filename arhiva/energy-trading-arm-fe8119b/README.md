# ⚡ Energy Trading Agent — Power Cross-Border Operations

## Simplu

```bash
./start.sh
```

Apoi, în grupul Telegram, o comandă pe zi:

```
/azi        → ce e deschis, ce e închis, ce propune, ce confirmi
/nomineaza XB-0001 XB-0002   → confirmi tu
```

Postezi în grup tabelul NTC, prețurile sau o decizie („skip UA-MD") — le ia
singur. La 09:00 primești același mesaj automat, fără să ceri nimic.

Pe laptop și iPhone: `tailscale serve --bg 8000` pe nodul RONOR, apoi
`https://<nod>.<tailnet>.ts.net/` → *Add to Home Screen*. Fiecare autorizare
poartă numele celui care a dat-o (din Tailscale sau din Telegram) — vezi
[deploy/README.md](deploy/README.md#tailscale--dashboard-ul-pe-laptop-și-iphone-uri-fără-expunere-publică).
Restul acestui document e pentru cine vrea detalii.

---

Autonomous agent for European cross-border electricity trading: it scans
day-ahead / intraday spreads across interconnectors, nets off transmission
tariffs and losses, applies risk + REMIT screens, nominates flows, and settles
cashflows — exposed via a FastAPI service and a live operations dashboard.

## How it works

```
Sense (prices + ATC) → Rank spreads → Risk / REMIT screen → Nominate → Settle
```

- **Sense** — `market_data.py`: simulated day-ahead feed (deterministic, with
  peak/off-peak shape and scarcity spikes), CSV loader, and an `EntsoeProvider`
  stub ready to wire to the ENTSO-E Transparency Platform (document type A44).
- **Rank** — `arbitrage.py`: evaluates every border × delivery hour in **both**
  flow directions, deducts tariff + loss-adjusted transport cost, keeps the
  economic direction, and ranks by expected profit.
- **Screen** — `risk.py`: per-border / portfolio / notional / VaR95 limits plus
  a lightweight REMIT market-abuse pre-trade screen.
- **Nominate** — `agent.py`: books trades; `nominate()` simulates TSO nomination
  (SDAC Euphemia / SIDC XBID for implicit borders, JAO eCAT for explicit ones
  such as GB and CH).
- **Settle** — `settlement.py`: realises cashflows for nominated trades.

## Borders covered

17 interconnectors: `FR-DE`, `DE-NL`, `BE-NL`, `FR-ES`, `DE-DK1`,
`DE-NO2-NORDLINK`, `IFA2-GB-FR`, `GB-NL-BRITNED`, `DE-PL`, `AT-IT-N`,
`CH-IT-N`, `FR-IT` — plus the eastern corridors `RO-UA`, `UA-MD`, `RO-MD`
(explicit auctions via Transelectrica / Ukrenergo / Molselectrica) and the
wheeling paths `UA-MD-RO` / `RO-MD-UA` (combined transit tariff + losses).
Directional spellings (`UA/RO`, `MD/UA`, `UA/MD/RO`, …) are normalized
automatically. Each border carries ATC, tariff, loss factor, coupling regime, TSO.

## Daily-ops intake (RO/UA/MD)

Paste the daily note as free text (RO or EN) — ATCs and hourly prices:

```
RO-UA ATC 450 MW
UA/MD ATC 600
RO-MD ATC 400
RO ora 18 pret 112,5
MD 19h 121
```

- `POST /api/ops-parse` → `{availability, prices_override, warnings}`
- Feed the result straight into `POST /api/run`
  (`availability` + `prices_override`), or use the **Date zilnice** panel in
  the dashboard: *Parsează* to preview, *Parsează + Rulează* to trade on it.
- Excel workbooks: `POST /api/ops-upload?day=2026-09-12` (multipart `file`,
  max 10 MB) or the 📎 button in the dashboard. Understood layouts: hour
  matrix (zones × 0–23), header tables (`Granita/ATC_MW`, `Zona/Ora/Pret`),
  and free-form rows. First value wins on conflicts (explicit details beat
  bulk matrix). Template: `templates/daily_ops_template.xlsx`
  (regenerate with `python templates/make_template.py`).

## Transferul zilnic WhatsApp → agent

**Varianta 1 — manuală, funcționează azi.** Pe telefon: deschideți Excel-ul în
WhatsApp → Share/Salvare în Files → atașați-l aici în conversație (ca PDF-ul
trimis anterior) sau încărcați-l cu butonul 📎 din dashboard. Agentul îl
parsează prin `/api/ops-upload`. Recomandat: completați zilnic
`templates/daily_ops_template.xlsx` (foile ATC / Preturi / Matrice_ore).

**Varianta 2 — automată (necesită deployment).** WhatsApp Business Cloud API
→ webhook către serviciul FastAPI (deja pregătit: `POST /api/ops-upload`
primește fișierul). Pași: aplicație Meta + număr Business, webhook validat pe
URL-ul public al serviciului, forward documentelor primite către endpoint.
Disponibil când serviciul e deployat pe infrastructură proprie — spuneți și
pregătesc configurația webhook-ului.

**Regulă de doctrină:** fiecare ingestie zilnică e înregistrată în registrul
de afirmații cu `evidence_level=operator_provided` — cifra circulă mereu cu
sursa ei.

## Quickstart

```bash
pip install -e ".[dev]"

# Run the service (dashboard at http://localhost:8000)
uvicorn energy_trading.api:app --reload

# Run one trading day headlessly
python - <<'EOF'
from datetime import datetime
from energy_trading.agent import CrossBorderAgent
agent = CrossBorderAgent()
trades, log = agent.run_day(datetime(2026, 9, 12))
print(log.model_dump_json(indent=2))
print("Expected PnL €", sum(t.expected_pnl for t in trades))
EOF

# Tests + lint
python -m pytest tests/ -q
ruff check src tests
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + zone list |
| GET | `/api/interconnectors` | Border registry |
| POST | `/api/run` | Run agent for a delivery day (`day`, `min_net_spread`, `volume_mw`, `max_trades`, `availability`) |
| GET | `/api/book` | Trade book + portfolio summary |
| POST | `/api/nominate` | Nominate trade IDs to TSOs |
| POST | `/api/settle` | Settle nominated trades |
| POST | `/api/reset` | Clear book (demo/testing) |
| GET | `/api/jobs` | Scheduler status, schedule, last runs, restored state |
| POST | `/api/jobs/{weather,hub_run,evening}` | Run a daily job now (`?day=`) |
| GET | `/api/alerts` | Alert stream (thresholds, worker errors, job failures) |
| GET | `/api/briefs` | Archived daily briefs (`?day=`) |
| GET | `/api/ingest-log` | What the Telegram bot ingested |
| POST | `/api/telegram/webhook` | Telegram Bot API webhook (secret-token protected) |
| POST | `/api/telegram/set-webhook` | Register the webhook + command menu with Telegram |
| POST | `/api/ronor` | **RONOR's own model with tools**: Ollama reads the message, calls the capabilities it needs, answers from their output only; falls back to `/api/operator` without Ollama. Same token guard |
| POST | `/api/operator` | Operator-bot brain over HTTP (`{"text": "/hub 13.09", "chat_id": "..."}`); integration point for an existing RONOR dispatcher; guarded by `X-RONOR-Token` when `ET_API_TOKEN` is set |

## Wiring live data

1. Get an ENTSO-E API token and implement `EntsoeProvider.day_ahead()` against
   `https://web-api.tp.entsoe.eu/api?documentType=A44…` (bidding-zone EIC codes).
2. Feed JAO explicit-auction results / ENTSO-E ATC (document A25/A26) into the
   `availability` map on `/api/run` to reflect real cross-border capacity.
3. Tighten `RiskLimits` (credit, per-border, VaR95) and point the REMIT screen
   at your surveillance taxonomy before connecting execution.

## Doctrina operațională: suveranitate energetică

Teza centrală a operațiunilor (*The New Renaissance* v3.0) e tradusă în
controale implementate — detalii în `docs/SOVEREIGNTY_DOCTRINE.md`:

- **Registrul afirmațiilor** (`GET /api/claims`) — fiecare rulare, nominalizare
  și decontare e înregistrată cu nivel de evidență (`simulated` /
  `operator_provided` / `tso_validated`) și referință la intrări; nicio cifră
  nu circulă fără sursă
- **Contabilitate energie→carbon** (`GET /api/sovereignty`) — MWh + tCO₂
  estimate raportate alături de economie, nu colapsate într-un scor
- **Balanța suveranității** — exporturi/importuri/net pe zona-gazdă (`?home=RO`),
  dependență de import, flag de concentrare pe graniță
- **Autoritatea finală rămâne umană** — agentul propune, operatorul nominalizează

## România ca HUB regional

RO (OPCOM DAM) este prețul de referință. Fiecare zonă vecină — **BG, RS, HU,
MD, UA** — e cotată ca *basis* față de RO pe fiecare oră, iar hub-ul decide:

- **import** dinspre vecinul mai ieftin / **export** spre cel mai scump
  (dimensionat pe capacitatea direcțională orară din NTC)
- **wheeling** vecin → RO → vecin când basis-ul combinat acoperă ambele legs
  (tarif + pierderi pe fiecare)

`POST /api/hub` (`day`, `prices_override`, `availability`) → basis pe
zonă×oră, oportunități de wheeling, sumar. Granițe noi: `RO-BG`, `RO-RS`,
`RO-HU` (aliasuri `BG/RO` etc. normalizate). Modul: `src/energy_trading/hub.py`.

## Workeri de prognoză meteo (RO + BG, RS, HU, MD, UA)

`WeatherOrchestrator` rulează în paralel un `WeatherWorker` per țară pe
[Open-Meteo](https://open-meteo.com) (gratuit, fără cheie), pe puncte
relevante pentru rețea (ex. Dobrogea pentru eolian RO), și derivă trei
semnale energetice — **cerere** (temperatură), **eolian** (vânt la 100 m),
**solar** (radiație) — plus o lectură de hub în română (presiune de export
RO, cerere de import în sud etc.). `GET /api/weather?days=3&countries=RO,BG`.
Eșecurile de rețea nu opresc pipeline-ul: workerul raportează `status=error`.
Brief-urile zilnice se arhivează în `data/weather/`.

## Date operaționale ingerate

`data/ntc_YYYY-MM-DD.csv` (NTC orar direcțional), `data/prices_*.csv`
(RO DAM / UA DAM / MD), `data/bids_*.csv` (poziția noastră: coridor/interval,
MW câștigați, preț CBC, limita de ofertare, `filled_mw` executat și
`realized_eur` contabilizat de operator), `data/pnl_summary_*.csv`
(centralizator lunar import/export).

**Operațiunile reale, zilnic.** Foaia operatorului — `Capacity won / CBC Price /
Bid Limit Price` pe coridoare (`Ua - Md`, `Md - Ro`, `Ro - Ua`, `Ua - Ro`,
`Transfer`) × intervale CET, plus `Nominated MW` și `Profit EUR` după livrare —
se postează ca `.xlsx` sau `.csv` în grupul Telegram (sau `POST /api/ops-upload`)
cu ziua în nume/mesaj. Intake-ul o recunoaște după antet, scrie/îmbină
`data/bids_<zi>.csv` (dimineața poziția, seara același fișier completat), iar
veghea reface pe loc: ziua viitoare → brief nou; ziua livrată → **P/L Digital
Twin recalculat cu fill-urile reale** și cu „raportat de tine” lângă calculul
modelului — diferența e semnalul de calibrare (costuri/bază pe care modelul nu
le vede încă). Șablon: `templates/operatiuni_zilnice_template.xlsx`.

Când există `bids_<zi>.csv`, capacitatea câștigată **înlocuiește** NTC-ul pe
frontierele estice (ce nu am câștigat = 0), prețul CBC intră în costul de
transport, iar pentru orele în care doar un capăt are preț brief-ul dă
**limita de ofertare** pe celălalt capăt (cumpărare sub / vânzare peste) și,
dacă operatorul și-a trecut limitele, modelul de cost implicit al acestora
(`📐`, calibrarea twin-ului).

## Operare 24/7 (fără intervenție manuală)

Serviciul veghează continuu (ora București) și își păstrează starea pe disc
între restarturi (`state/`, JSON lizibil). Patru momente fixe pe zi, plus
veghe permanentă între ele:

| Când | Job | Ce face |
|---|---|---|
| 06:00 | `weather` | workerii meteo din 6 țări → brief + lectură de hub → alerte |
| 07:00 | `pnl` | **P/L Digital Twin** pentru ziua livrată ieri: ce a câștigat real poziția (capacitate câștigată × limite/fill-uri × prețuri de închidere publicate), ce ar fi făcut twin-ul, idealul cu hindsight, CBC plătit, ore ratate, cumulat lunar → un mesaj |
| 09:00 | `hub_run` | basis vs RO + rulare agent pe NTC-ul/prețurile zilei următoare → **un singur mesaj** cu ziua |
| 18:00 | `evening` | recap suveranitate/P&L al book-ului → alerte de concentrare |
| la 15 min | `fetch` | citește singur prețurile publicate — **OPCOM PZU** (RO, CET, 15 min → ore) și **OREE DAM + curs NBU** (UA, Kyiv → CET, UAH → EUR) — pentru azi și mâine, le pune în `data/prices_*.csv`; valorile tastate de mână sunt verificate o dată și corectate dacă diferă |
| la 1 min | `watch` | orice intrare nouă (`data/ntc_*.csv`, `data/prices_*.csv`, `data/bids_*.csv`, decizii din chat) → ziua afectată **refăcută pe loc**, mesaj cu motivul; operațiuni reale pentru o zi livrată → P/L twin refăcut |
| la 60 min | `settle` | tranzacțiile nominalizate cu ora de livrare trecută → decontate, P&L realizat raportat |
| continuu | `gate` | propuneri neautorizate pentru mâine + gate day-ahead (13:00) în ≤60 / ≤15 min → memento operatorului, o dată pe prag |
| la 60 min | `heartbeat` | puls; la repornire după o pauză lungă anunță cât a lipsit |
| la nevoie | reîncercări | un job picat se reia la 10 min, de 3 ori, apoi escaladează o singură dată |

Job-urile zilnice ratate (serviciul oprit la ora lor) rulează imediat ce
revine. Intrările vin **automat din grupul Telegram**: botul primește `.xlsx`
și note text, le parsează prin intake, răspunde cu ce a înțeles — și veghea
reface ziua în cel mult un minut. Alertele pleacă tot pe Telegram. Același
bot (RONOR) e **interfața operatorului**, în limbaj natural. **Nominalizarea
rămâne decizie umană** — agentul propune, omul confirmă, memento-ul îl
strigă înainte de gate.

```bash
cp .env.example .env && docker compose up -d --build
```

Detalii complete (Docker, systemd, configurare bot, securitate):
[`deploy/README.md`](deploy/README.md).

## RONOR capabil — modulul ca parte a nodului suveran

Tot ce știe modulul e expus lui RONOR ca **19 unelte** definite o singură dată
(`capabilities.py`) și oferite pe trei căi: Ollama tool calling (`/api/ronor` —
modelul lui RONOR gândește și apelează), un server MCP pe stdio pentru orice
alt agent din nod, și `ronor/tools.json` pentru rutare statică. Guardrail:
uneltele care schimbă starea rulează doar dacă omul a cerut-o explicit, iar
nominalizarea se scrie sub numele lui. Instalare pe nod într-o comandă
(`ronor/install.sh`: container → health → creează modelul `ronor-energy` cu
doctrina în `SYSTEM` → plugin de dispatcher). Detalii:
[`ronor/CAPABILITY.md`](ronor/CAPABILITY.md).

## Layout

```
src/energy_trading/  models · interconnectors · market_data · arbitrage
                      agent · risk · settlement · ops_intake · sovereignty
                      hub · weather · api
                      config · store · scheduler · alerts · telegram_bot  (24/7)
                      operator_bot  (RONOR Bot: comenzi + Q&A din documentație)
                      capabilities · ronor_agent · mcp_server  (RONOR capabil: unelte, Ollama, MCP)
ronor/                pachetul pentru nod: install.sh · pack.sh · Modelfile · tools.json
                      dispatcher_plugin.py · CAPABILITY.md
static/               operations dashboard (index.html · app.js · styles.css)
deploy/               Dockerfile helpers: systemd unit + deployment guide
tests/                104 pytest cases: engine, risk, intake, hub, weather, ops 24/7, bot
```
