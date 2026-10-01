# R-PowerTrade: brațul de trading energetic transfrontalier al RONOR

Specificația este exportul consolidat v0.1 din 27.09.2026, lucrat cu Muse. Constructorul lucrează în cadrul RONOR. Serviciul anterior, `energy-trading-arm`, a fost mutat intact în `arhiva/energy-trading-arm-fe8119b/`.

## Principiu
R-PowerTrade propune, iar RONOR decide. Nicio cifră nu vine dintr-un model de limbaj. În Etapa 1, R-PowerTrade nu nominalizează și nu execută.

## Etape
- **Shadow (acum).** R-PowerTrade calculează limitele și închiderea zilei și le scrie în registru. Operatorul decide în afara sistemului.
- **Gated.** Pentru a trece aici, trebuie ca `pl_vs_perfect` și `cbc_mape` să fie evaluate pe istoric, iar botul trebuie să afișeze butoanele Da/Nu, cu Nu ca răspuns implicit.
- **Arm.** Numai cu aprobare explicită a suveranului.

## Canonul de bani, în cod
| Regulă | Unde |
|---|---|
| Unde UA e implicat: 50% Yunex, 50% RO; felia RO se împarte 50% Encon, 50% NrgPath | `tools/split.py` |
| Tranzit prin MD: aceeași regulă ca pe rutele cu UA, felia RO pe Encon Group (Encon + WATT) 50% / NrgPath 50%; partea WATT scoasă de pe tranzit (corecția din 01.10.2026) | `tools/split.py` |
| RO↔MD pur: 50% WattMD, 50% NrgPath; singura linie WATT separată | `tools/split.py` |
| Provizion CBAM: 40 €/MWh pentru origine UA, 30 €/MWh pentru origine MD, numai la intrarea în RO, în afara P/L | `tools/provision.py` |
| Limita de cumpărare: `(preț_UA − 0,9 − CBC − 0,5) / 1,01` | `tools/limits.py` |
| Starea explicită a prețului; numai `real` trece de gardă | `tools/unknown.py` |
| CBC efectiv ponderat pe tranșe; F1 semnalează o plată dublă | `tools/cbc.py` |
| Registru numai cu adăugare, fiecare rând semnat HMAC și înlănțuit | `ledger/ledger.py` |

## Contract
Toate rutele cer antetul `X-RONOR-Token`. Dacă tokenul lipsește din configurare, serviciul refuză cererile.

| Rută | Rol |
|---|---|
| `POST /powertrade/limits` | Tabelul limită/oră din forecast, CBC și NTC |
| `POST /powertrade/forecast` | Înregistrează intrările postate în grup: NTC, forecast, CBC, vânzări |
| `POST /powertrade/close` | Închiderea zilei: brut, provizion, împărțire, cumul RO |
| `POST /powertrade/dispute-learn`, `POST /api/dispute` | Disputele; textul nu este parsat în cifre |
| `GET /api/ledger/verify` | Verificarea lanțului HMAC |
| `POST /api/nominate` | Răspunde 403 cât timp etapa nu este Arm |

## Acceptare
Comanda de acceptare este `bash ops/doctor.sh`. Etapele A, R, B și C trebuie să treacă toate. Cazurile înghețate sunt în `eval/cases/`.

## Confirmări (Muse, 27.09.2026)
1. Tranzitul prin MD (decizia suveranului, 28.09.2026): Yunex 50%, WATT 25%, NrgPath 25%. WATT este afiliatul Encon, deci Encon Group = Encon + WATT. Înlocuiește varianta 25/12,5/12,5.
2. Parametrii: tariful este 0,9, spread-ul minim 0,5, iar coeficientul de pierderi 1,01.
3. Starea prețului se marchează explicit: `real`, `missing`, `substitute` sau `suspect`, cu proveniență. O valoare fără status sau fără proveniență e tratată ca neverificată. Garda blochează orice stare diferită de `real`. Un preț de 0 €, de 0,20 € sau negativ e acceptat dacă e marcat `real`.

## Etapa 2: construcția pentru Gated (fără efect operațional)

| Componentă | Ce face | Unde |
|---|---|---|
| Regimul de criză | plafon 10 MW pe interval, 8 obligatoriu pe 8 și 16; spread 1,0; intrazilnic numai după câștig confirmat; pauză 17–21 fără aprobare scrisă; propunerea „8 peste tot” doar ca scenariu (`strict`) | `tools/crisis.py` |
| Potențialul executabil | volum = min(drepturi, plafon); cost scufundat pe MW câștigați și nefolosiți; provizion pe MWh intrați în RO; marcat „nu susține nominalizarea” dacă intrările nu sunt reale | `tools/potential.py` |
| Propuneri Da/Nu | `POST /powertrade/propose` verifică garda și regimul de criză și înregistrează propunerea cu răspunsul implicit NU; `POST /powertrade/decide` înregistrează Da/Nu numai în Gated, iar un Da cere referința aprobării scrise. Nimic nu execută. | `api.py` |
| Istoricul | `POST /powertrade/outcome` înregistrează rezultatele reale; `GET /powertrade/metrics` calculează `cbc_mape`, `pl_vs_perfect`, `floor_hit_rate`, `false_cbc_rate` și verdictul pentru Gated; sub `min_history_days` metricile sunt „neevaluat” | `eval/history.py` |
| Cazul 02.10 | reproduce exact potențialul din raportul Muse v4: 5.624,12 (regula în vigoare), 4.601,20 (scenariul 8), 13.217,74 (fără plafon) | `eval/cases/2026-10-02_potential.json` |

`/api/nominate` rămâne 403 în Shadow și în Gated. `min_history_days` (20) este o propunere de construcție, de confirmat.
