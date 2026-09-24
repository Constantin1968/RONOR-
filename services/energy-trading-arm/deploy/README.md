# Deployment — operare 24/7

Pachetul rulează ca un serviciu FastAPI cu scheduler intern. Nu are nevoie de
nimic altceva: fără bază de date, fără broker, fără cron extern. Starea se
scrie pe disc în `state/` (JSON lizibil, backup cu `cp -r`).

## Ce face singur, 24/7 (ora locală București)

| Când | Job | Ce face |
|---|---|---|
| 06:00 | `weather` | 6 țări în paralel → brief meteo → semnale cerere/eolian/solar |
| 09:00 | `hub_run` | NTC + prețuri pentru ziua următoare → propuneri → un singur mesaj cu ziua |
| 18:00 | `evening` | recap suveranitate/P&L → alerte de concentrare |
| la 1 min | `watch` | fișier nou în `data/` sau decizie din chat → ziua refăcută pe loc, mesaj cu motivul |
| la 60 min | `settle` | ore livrate → decontate, P&L realizat |
| continuu | `gate` | propuneri neautorizate pentru mâine, gate 13:00 în ≤60/≤15 min → memento |
| la 60 min | `heartbeat` | puls; după o pauză lungă anunță „repornit după ~N h” |
| la nevoie | reîncercări | job picat → reia la 10 min ×3 → escaladează o dată |

Job-urile zilnice ratate se recuperează la repornire. `/status` (sau
`GET /api/jobs`) arată ce urmează, ce veghează, ce reîncearcă.
`POST /api/jobs/tick` forțează o trecere a buclei acum.

### Ce ține serviciul în viață, la nivel de sistem

- Docker: `restart: unless-stopped` + `healthcheck` pe `/api/health`
  (verificat la 60 s). Containerul picat e repornit de Docker; job-urile
  ratate se recuperează singure la pornire.
- systemd: `Restart=always`, `RestartSec=5`; jurnalul în `journalctl -u
  energy-trading-agent`.
- Starea (`state/`) e volum persistent: book, claims, override-uri, ultimele
  rulări, pulsul. Fără ea, la repornire agentul pornește gol — nu ștergeți
  volumul `agent-state`.
- Ceasul: containerul folosește UTC intern și `ET_TIMEZONE=Europe/Bucharest`
  pentru program; nu depinde de ora host-ului.

## Opțiunea A — Docker (recomandat)

```bash
cp .env.example .env        # completați token-urile Telegram
docker compose up -d --build
curl localhost:8000/api/health     # "scheduler": true
curl localhost:8000/api/jobs       # program + ultimele rulări
```

Datele operaționale (`data/ntc_*.csv`, `data/prices_*.csv`) sunt montate din
gazdă — le puteți depune și manual, scheduler-ul le ia la 09:00.

## Opțiunea B — VPS cu systemd

```bash
sudo useradd -r -s /usr/sbin/nologin trader
sudo mkdir -p /opt/energy-trading-agent && sudo chown trader /opt/energy-trading-agent
sudo -u trader git clone <repo> /opt/energy-trading-agent   # sau rsync
cd /opt/energy-trading-agent
sudo -u trader python3 -m venv .venv && sudo -u trader .venv/bin/pip install .
sudo -u trader cp .env.example .env && sudo -u trader nano .env
sudo cp deploy/energy-trading-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now energy-trading-agent
journalctl -u energy-trading-agent -f
```

## Ingestie automată din Telegram

1. Aveți deja botul (ex. **RONOR Bot**)? În [@BotFather](https://t.me/BotFather):
   `/mybots` → botul → *API Token* → `TELEGRAM_BOT_TOKEN`. Altfel `/newbot`.
   Tot acolo: *Bot Settings → Group Privacy → Turn off*, ca botul să vadă
   toate mesajele din grup, nu doar comenzile.
2. Adăugați botul în grupul de trading; aflați `chat_id` (ex. trimiteți un
   mesaj și citiți `https://api.telegram.org/bot<TOKEN>/getUpdates`) →
   `TELEGRAM_CHAT_ID` (pentru alerte) și `TELEGRAM_ALLOWED_CHATS` (cine poate
   alimenta agentul)
3. Generați `TELEGRAM_WEBHOOK_SECRET` (ex. `openssl rand -hex 24`)
4. Expuneți serviciul pe HTTPS (Caddy/nginx/Cloudflare Tunnel) și înregistrați
   webhook-ul:

```bash
curl -X POST "localhost:8000/api/telegram/set-webhook?public_url=https://agent.exemplu.ro"
```

De acum, orice `.xlsx` sau notă text („RO-UA ATC 450 MW", „UA ora 18 pret 68")
postată în grup e parsată automat; botul răspunde cu ce a înțeles, iar ingestia
apare în `GET /api/ingest-log`. Data se deduce din caption/nume fișier
(`12.09`, `13.09.2026`), altfel e ziua curentă.

## RONOR Bot ca interfață de operator

Botul nu are memorie proprie — „învață" tot ce e construit aici pentru că
serviciul acesta îi răspunde la comenzi. `set-webhook` publică și meniul de
comenzi în Telegram (`setMyCommands`).

| Comandă | Ce face |
|---|---|
| `/hub [zi]` | basis vs RO pe zone, cel mai bun wheeling; marchează dacă prețurile sunt reale sau simulate |
| `/ntc [zi]` | ATC min/medie/max pe granițe din ultimul NTC |
| `/meteo` | brief meteo RO+vecini + lectura pentru fluxuri |
| `/propuneri [zi]` | rulează agentul acum pe datele zilei; listează propunerile |
| `/book` | book-ul pe statusuri |
| `/nomineaza XB-0001 …` | **decizia umană**: confirmă nominalizarea (înregistrată ca `operator_provided`) |
| `/deconteaza` | decontează ce e nominalizat |
| `/suveranitate` | balanță RO, dependență de import, concentrare pe graniță |
| `/status` `/alerte` `/claims` | operare, alerte, registrul afirmațiilor |
| `/granite` `/doctrina` `/ajutor` | referință |

Ziua acceptă `13.09`, `2026-09-13`, `azi`, `maine`. Comenzile funcționează și
cu sufix (`/hub@RONORBot`). **Întrebări libere** („ce e basis-ul față de RO?")
primesc răspuns din documentația sistemului (README, doctrină) — fără model
extern, deci fără halucinații: dacă nu găsește, spune că nu găsește.

Aceeași logică e disponibilă și prin HTTP pentru dashboard/teste:
`POST /api/operator {"text": "/hub 13.09"}`.

Ce **nu** face botul din chat: nu nominalizează singur, nu schimbă limitele de
risc, nu șterge book-ul. Cine poate vorbi cu el e controlat prin
`TELEGRAM_ALLOWED_CHATS`.

## Integrare cu nodul RONOR existent (Hetzner + CIDA + Ollama)

> **Calea scurtă:** `./ronor/pack.sh` aici, apoi pe nod
> `OLLAMA_URL=http://<contabo>:11434 RONOR_NETWORK=ronor ./ronor/install.sh`.
> Face tot ce descrie această secțiune, creează modelul `ronor-energy` pe
> Ollama și tipărește codul de dispatcher. Detalii și ce devine RONOR capabil
> să facă: [`../ronor/CAPABILITY.md`](../ronor/CAPABILITY.md).

Dacă RONOR Bot **are deja un backend** care îi consumă update-urile Telegram
(rapoarte de sănătate, audit, CIDA), **nu apelați `set-webhook`** — Telegram
acceptă un singur consumator per bot și ați rupe fluxul existent. Modelul
corect e: backend-ul RONOR rămâne proprietarul conversației, iar serviciul
acesta e un **modul de energie** pe care îl întreabă.

```
Telegram ──► backend RONOR (dispatcher) ──► POST /api/operator  ──► răspuns
                                       └──► POST /api/ops-upload (fișiere .xlsx)
serviciul energie ──► sendMessage (alerte) ──► același bot, același grup
```

Trimiterea de alerte cu token-ul botului e sigură: Telegram permite oricâți
*emițători*, doar un singur *receptor*.

### 1. Rulați serviciul ca al 63-lea container pe Hetzner

```bash
git clone <repo> /opt/ronor/energy && cd /opt/ronor/energy
cp .env.example .env
# TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (alerte), ET_API_TOKEN=$(openssl rand -hex 24)
# OLLAMA_URL=http://<contabo>:11434  OLLAMA_MODEL=qwen2.5   (sau qwen3.5 / llama3.1)
docker compose up -d --build
curl -s localhost:8000/api/health
```

### 2. Forwarding din dispatcher-ul RONOR

Rutați către modulul de energie: comenzile din lista `/ajutor`, documentele
`.xlsx`, și mesajele care conțin granițe/ATC/prețuri. Exemplu minimal (Python):

```python
import requests

ENERGY = "http://energy:8000"          # numele containerului în rețeaua compose
HEADERS = {"X-RONOR-Token": ET_API_TOKEN}
ENERGY_CMDS = {"hub", "ntc", "meteo", "propuneri", "book", "nomineaza", "deconteaza",
               "suveranitate", "alerte", "claims", "granite", "doctrina", "status"}

def handle_message(msg: dict) -> str | None:
    chat_id = str(msg["chat"]["id"])
    text = msg.get("text") or msg.get("caption") or ""
    doc = msg.get("document")

    if doc and doc["file_name"].lower().endswith((".xlsx", ".xlsm")):
        data = download_telegram_file(doc["file_id"])            # helperul vostru existent
        r = requests.post(f"{ENERGY}/api/ops-upload", headers=HEADERS,
                          params={"day": infer_day(text)},
                          files={"file": (doc["file_name"], data)}, timeout=30)
        return format_intake(r.json())

    cmd = text[1:].split("@")[0].split()[0].lower() if text.startswith("/") else ""
    if cmd in ENERGY_CMDS or looks_like_energy(text):
        r = requests.post(f"{ENERGY}/api/operator", headers=HEADERS,
                          json={"text": text, "chat_id": chat_id}, timeout=90)
        body = r.json()
        return body["reply"] if body["accepted"] or body["reply"] else None
    return None                                                  # nu e pentru energie
```

`/api/operator` întoarce `kind` (`command` / `text` / `question` / `ignored`)
ca dispatcher-ul să știe dacă modulul a recunoscut mesajul; `ignored` fără
`reply` înseamnă „nu e al meu", lăsați-l altui modul.

### 3. Ollama ca creier suveran pentru întrebări libere

Cu `OLLAMA_URL` setat, întrebările libere nu mai primesc doar secțiunea din
documentație, ci un răspuns compus de modelul local **strict din**: secțiunile
relevante (README, doctrină) + o stare live scurtă (book, ultimele job-uri,
alerte). Instrucțiunea de sistem îi interzice cifre inventate și recomandări
de nominalizare; dacă contextul nu acoperă întrebarea, spune explicit. Dacă
Ollama e ocupat sau picat, botul cade înapoi pe răspunsul din documentație —
nu tace niciodată. `/status` arată care mod e activ.

Modele testate ca potrivite din lista voastră: `qwen2.5` (rapid, română
acceptabilă), `qwen3.5` (mai bun pe raționament), `llama3.1`. `deepseek-r1`
produce lanțuri lungi de gândire — util pentru analiză, prea lent pentru chat.

### 4. CIDA

Baza de cunoștințe a modulului e formată din documentele din acest repo. Dacă
vreți ca răspunsurile să tragă și din CIDA (6.254 documente), cel mai simplu
punct de cuplare este `KnowledgeBase(files=[...])` — îi puteți da orice fișiere
Markdown/text exportate din CIDA pe teme de energie; secțiunile se indexează la
pornire.

## Tailscale — dashboard-ul pe laptop și iPhone-uri, fără expunere publică

Serviciul nu trebuie să fie pe internet. Îl publicați în tailnet-ul RONOR și
fiecare device (laptop, iPhone-urile voastre, ale Nataliei) îl vede la aceeași
adresă, cu HTTPS și identitate garantată de Tailscale.

```bash
# pe host-ul unde rulează containerul (deja în tailnet)
tailscale serve --bg 8000
# → https://<hostname>.<tailnet>.ts.net/  (certificat automat, MagicDNS)
```

Ce câștigați:

- **Identitate pe fiecare autorizare.** `tailscale serve` adaugă header-ele
  `Tailscale-User-Login` / `Tailscale-User-Name`; agentul le citește și scrie
  numele operatorului în trade (`nominated_by`, `nominated_at`) și în registrul
  de claims: *„2 trades nominated by natalia@… (XB-0003, XB-0004)"*. Doi
  operatori, o singură pistă de audit. Din Telegram, numele vine din expeditor.
- **Fără parole, fără token.** Cine nu e în tailnet nu ajunge la serviciu.
  `ET_API_TOKEN` rămâne util doar pentru dispatcher-ul RONOR dacă vine din alt
  tailnet sau de pe internet.
- **iPhone ca aplicație.** Deschideți adresa în Safari → Share → *Add to Home
  Screen*. Se instalează ca „RONOR", ecran complet, fără bară de adresă; butoane
  și căsuțe dimensionate pentru deget, tastatura nu face zoom pe câmpul de chat.

Restricționați accesul din ACL-ul tailnet-ului (ex. doar tag-ul `tag:ops`
către portul 443 al nodului). Webhook-ul Telegram, dacă îl folosiți direct,
este singurul lucru care are nevoie de internet — pentru asta `tailscale
funnel 8000` sau, mai curat, lăsați dispatcher-ul RONOR existent să forward-eze
(secțiunea de mai sus). Alertele către Telegram sunt doar ieșiri (outbound) și
merg din orice rețea.

## Verificare după deploy

```bash
curl -X POST localhost:8000/api/jobs/weather      # rulare manuală
curl -X POST "localhost:8000/api/jobs/hub_run?day=2026-09-13"
curl localhost:8000/api/alerts
curl localhost:8000/api/briefs
curl localhost:8000/api/claims
```

## Securitate

- Toate secretele vin din mediu (`.env`, în `.gitignore`); nimic în cod
- Webhook-ul refuză cereri fără `X-Telegram-Bot-Api-Secret-Token` corect (403)
- Chat-urile neautorizate sunt ignorate silențios
- Containerul rulează ca utilizator neprivilegiat; unitatea systemd e
  sandboxată (`ProtectSystem=strict`)
- Endpoint-urile de operare (`/api/jobs/*`, `/api/reset`) nu au autentificare
  proprie: puneți serviciul în tailnet (`tailscale serve`, secțiunea de mai sus)
  sau în spatele unui reverse proxy cu auth; expuneți public **doar**
  `/api/telegram/webhook`, dacă îl folosiți
