# RONOR devine capabil: modulul de energie ca parte a nodului

Acest director este tot ce i se dă lui RONOR. După instalare, RONOR — cu
creierul lui (Ollama), în infrastructura lui — poate să:

| Capabilitate | Ce face RONOR | Unealta |
|---|---|---|
| Vede ziua | prețuri (reale/simulate), NTC pe ore, ce e închis / subțire, ce propune, ce așteaptă confirmare | `ziua(day)` |
| Citește capacitățile | NTC/ATC pe RO-UA, UA-RO, UA-MD, MD-UA, RO-MD, MD-RO — medie, minim, ferestre utile | `capacitate(day)` |
| Gândește ca hub | basis-ul RO față de HU/BG/RS/MD/UA, wheeling, arbitraj | `hub(day)` |
| Știe vremea | prognoze + semnale cerere/eolian/solar pe 6 țări | `meteo()` |
| Propune | rulează agentul: spread-uri nete, risc, REMIT → propuneri `proposed` | `propuneri(day)` |
| Cere confirmarea | listează ce așteaptă omul, cu ID-uri | `de_autorizat()` |
| Execută ce a autorizat omul | nominalizează, sub numele celui care a spus-o | `autorizeaza(ids)` |
| Decontează | P&L realizat pe livrările trecute | `deconteaza()` |
| Primește date brute | tabel NTC lipit, prețuri pe intervale, „skip UA-MD” — le parsează și le aplică | `noteaza(text)` |
| Se explică | doctrina, registrul afirmațiilor, alertele, starea | `doctrina() registru() alerte() status() suveranitate()` |
| Răspunde ancorat | întrebări conceptuale (basis, cuplare, REMIT) din documentație, nu din memorie | `intreaba(intrebare)` |
| Veghează 24/7 | meteo 06:00, ziua 09:00, recap 18:00; între ele: date noi → ziua refăcută în ≤1 min, ore livrate decontate, memento înainte de gate, job-uri picate reîncercate, job-uri ratate recuperate la repornire | `activeaza() opreste() status()` |

Toate cele 19 unelte sunt definite **o singură dată**, în
`src/energy_trading/capabilities.py`, și expuse pe trei căi:

```
                    ┌─ Ollama tool calling ── /api/ronor ─────┐  RONOR gândește și apelează
capabilities.py ────┼─ MCP (stdio) ─── energy_trading.mcp_server  alți agenți din nod apelează
                    └─ ronor/tools.json ────────────────────────┘  dispatchere care rutează static
```

## Cum îl instalezi pe nod (o comandă)

```bash
./ronor/pack.sh                       # aici → dist/ronor-energy-0.2.0.tar.gz
# pe Hetzner:
tar xzf ronor-energy-0.2.0.tar.gz && cd ronor-energy
OLLAMA_URL=http://<contabo>:11434 OLLAMA_BASE=qwen2.5 RONOR_NETWORK=ronor ./ronor/install.sh
```

`install.sh` face, în ordine: `.env` cu token generat → container în rețeaua
RONOR → health → **creează modelul `ronor-energy`** pe Ollama (doctrina și
regulile în `SYSTEM`, prin `/api/create`) → regenerează `tools.json` și
`Modelfile` din registru → tipărește exact codul pentru dispatcher.

## Cum îl legi de dispatcher-ul RONOR (10 linii)

```python
from dispatcher_plugin import EnergyModule  # ronor/dispatcher_plugin.py, doar stdlib

energy = EnergyModule(
    "http://energy-trading-agent:8000",
    token=os.environ["ET_API_TOKEN"],
    trading_chats={"-100123456789"},
)  # grupul de trading: totul e al lui


def on_message(msg):  # update["message"] de la Telegram
    reply = energy.handle(msg, download_file=telegram_download)
    if reply is not None:  # None = nu e despre energie
        send(msg["chat"]["id"], reply)
```

`handle` decide singur: `.xlsx` → `/api/ops-upload` (parsează și aplică zilei);
text → `/api/ronor`. În grupul de trading totul merge la modul; în alte
chat-uri doar comenzile și mesajele care arată a energie (`looks_like_energy`).
Numele expeditorului Telegram devine `who` și ajunge în registrul de claims la
fiecare autorizare.

## Ce se întâmplă la un mesaj (`/api/ronor`)

0. **Rutare întâi.** Dacă mesajul e o notă operațională (tabel NTC lipit,
   prețuri pe intervale, „skip UA-MD 14.09”) merge direct la intake și se
   aplică zilei. Dacă e o cerere clară în română („cum stă ziua 13.09”,
   „ce am de autorizat”, „autorizez XB-0001 XB-0002”) se execută determinist
   și răspunsul e cel scris pentru oameni — **modelul nu e consultat**. Am
   verificat cu Ollama real: modelele mici sar peste unelte sau înlocuiesc
   conținutul cu fraze goale; RONOR nu trebuie să depindă de dispoziția lor.
1. Ce rămâne (întrebări libere, formulări ambigue, cereri compuse) ajunge la
   modelul `ronor-energy` cu lista de unelte.
2. Modelul decide ce apelează (`intreaba` pentru concepte, `ziua`,
   `capacitate`…). Fiecare apel devine o comandă a botului și se execută.
3. Compune răspunsul **doar** din ce au întors uneltele. Maximum 4 runde.
4. Guardrail-uri: uneltele care modifică starea rulează **numai** dacă mesajul
   omului cere asta explicit; `autorizeaza` în plus cere ca fiecare ID pe
   care modelul vrea să-l nominalizeze să apară în textul omului (sau omul să
   fi spus „tot”), și refuză formulările-întrebare („ce trebuie să
   autorizez?”). Un „hai să autorizăm tot” inventat de model e refuzat.
5. **Ancorare:** orice cifră din răspunsul final trebuie să existe în ieșirea
   unei unelte; altfel operatorul primește ieșirea uneltei ca atare. Cifre
   fără nicio unealtă în spate → răspunsul e aruncat.
6. Ollama picat / lent / răspuns gol → botul determinist răspunde. RONOR nu tace.

## MCP — pentru orice alt agent din nod

```bash
ET_API_URL=http://energy-trading-agent:8000 ET_API_TOKEN=... python -m energy_trading.mcp_server
```

Server MCP pe stdio, fără dependențe: `initialize`, `tools/list`, `tools/call`.
Uneltele read-only sunt marcate `readOnlyHint`; identitatea se transmite în
`_meta.who`. Configurație tipică de client:

```json
{ "mcpServers": { "ronor-energy": {
    "command": "python", "args": ["-m", "energy_trading.mcp_server"],
    "env": { "ET_API_URL": "http://energy-trading-agent:8000", "ET_API_TOKEN": "..." } } } }
```

## Din linia de comandă

```bash
python -m energy_trading.ronor_agent "cum stă ziua de mâine?"        # Ollama + unelte
python -m energy_trading.ronor_agent --modelfile qwen2.5 > Modelfile  # ce învață modelul
python -m energy_trading.ronor_agent --create-model qwen3.5           # recreează pe altă bază
```

## Ce NU face RONOR, prin construcție

- Nu nominalizează fără om. Unealta există, dar guardrail-ul și `SYSTEM`-ul o
  leagă de cuvântul explicit al operatorului; nominalizarea se scrie sub numele lui.
- Nu inventează cifre. Fiecare număr din răspuns are o unealtă în spate; fără
  unealtă modelul spune că nu știe.
- Nu preia webhook-ul Telegram. Dispatcher-ul RONOR rămâne proprietarul
  conversației; modulul e chemat și răspunde.
