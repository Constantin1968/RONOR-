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
| Tranzit prin MD: WATT preia felia RO; Encon Group (Encon + WATT) 50% / NrgPath 50% din felie | `tools/split.py` |
| RO↔MD pur: 50% WattMD, 50% NrgPath | `tools/split.py` |
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
