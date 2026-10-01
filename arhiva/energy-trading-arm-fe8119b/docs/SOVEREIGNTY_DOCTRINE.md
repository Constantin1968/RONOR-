# Doctrina operațională: suveranitate energetică și inteligență

Teza centrală a operațiunilor — *The New Renaissance*, Expanded Canonical Edition v3.0:

> Inteligența devine infrastructură civilizațională doar când observarea,
> raționamentul, decizia, execuția, verificarea, învățarea și memoria sunt
> reunite într-un sistem guvernabil, cu autoritatea finală la om.

Acest document traduce teza în controale implementate în agentul de trading
transfrontalier. Fiecare principiu are o corespondență în cod, nu doar pe hârtie.

## 1. Runtime-ul constituțional → pipeline-ul agentului

Cele patru proprietăți (Interlude II / cap. 9) sunt compilate în software:

| Proprietate doctrinară | Implementare |
|---|---|
| Separation (structura de permisiuni) | `RiskLimits`: plafoane pe graniță / portofoliu / noțional / VaR95; `blocked_borders`; allow-list de zone (`risk.py`) |
| Record (proveniența) | `ClaimsRegister`: fiecare rulare, nominalizare și decontare e înregistrată cu nivel de evidență și referință la intrări (`sovereignty.py`, `GET /api/claims`) |
| Challenge (calea de apel) | Ecranul REMIT + respingerea tranzacțiilor cu motiv; `DecisionLog.rejections` păstrează fiecare refuz |
| Renewal (politică versionată) | `AgentConfig` versionabil; `MarketDataProvider` substituibil (simulare → CSV → ENTSO-E) fără a schimba motorul |

## 2. Registrul afirmațiilor → nicio cifră fără evidență

Conform Agendei de cercetare, orice afirmație publică se leagă de nivelul ei de
evidență. Niveluri folosite:

- `simulated` — prețuri sintetice (implicite la `/api/run`)
- `operator_provided` — date zilnice lipite de operator via `/api/ops-parse`
- `tso_validated` — rezervat confirmărilor TSO/JAO (de marcat prin `confirm()`)

O afirmație „urcă" de la `provisional` la `confirmed` doar prin confirmare
explicită — criteriul de release al Agendei (replicare independentă + revizuire
adversarială, cu evidența arhivată).

## 3. Contabilitatea energie→inteligență (Workstream 2)

Fiecare tranzacție raportează lanțul fizic **alături** de economie, fără a le
colapsa într-un scor opac (`GET /api/sovereignty → energy`):

- MWh mutați fizic pe produsul orar
- tone CO₂ estimate după mixul zonei-sursă (valori implicite provizorii,
  de suprascris cu factorii publicați de TSO/ENTSO-E înainte de uz de conformitate)
- PnL așteptat, separat

## 4. Suveranitate, dependență și exit (cap. 14, 15, 20, 31, 32)

`GET /api/sovereignty?home=RO` arată balanța zonei-gazdă: exporturi vs importuri,
net, dependența de import și concentrarea pe granițe (flag peste 60% pe o
singură graniță — risc de dependență). Regulile de ieșire:

- Sursa de date e substituibilă (exit din simulare spre ENTSO-E fără refactorizare)
- Granițele explicite (RO-UA, UA-MD, RO-MD, tranzitele via MD) trec prin
  nominalizare TSO, nu prin cuplare implicită — controlul rămâne la operator
- Autoritatea finală rămâne umană: agentul **propune**, operatorul nominalizează
  și decontează din dashboard

## 5. Limitele creează formă (cap. 2 — Power of Limits)

Limitele de risc nu sunt fricțiune, ci forma care face sistemul guvernabil:
clipul implicit, plafonul de tranzacții/rulare, pragul de spread net minim și
ecranul de concentrare sunt „limite proiectate", nu lipsuri.

## 6. Ce ar dovedi că greșim (cap. 23 — falsifiabilitate)

- Spread-urile realizate diverg sistematic de cele estimate → recalibrare provider
- Factorii de carbon impliciți contrazic publicațiile TSO → suprascriere obligatorie
- O graniță devine structural dependentă (flag repetat) → revizuire de strategie,
  înregistrată în registru cel puțin la fel de tare ca afirmația inițială
