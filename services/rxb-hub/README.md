# RXB-Hub: brațul de trading energetic transfrontalier al RONOR

Specificația este exportul consolidat v0.1 din 27.09.2026, lucrat cu Muse. Constructorul lucrează în cadrul RONOR. Serviciul anterior, `energy-trading-arm`, a fost mutat intact în `arhiva/energy-trading-arm-fe8119b/`.

## Principiu
RXB propune, iar RONOR decide. Nicio cifră nu vine dintr-un model de limbaj. În Etapa 1, RXB nu nominalizează și nu execută.

## Etape
- **Shadow (acum).** RXB calculează limitele și închiderea zilei și le scrie în registru. Operatorul decide în afara sistemului.
- **Gated.** Pentru a trece aici, trebuie ca `pl_vs_perfect` și `cbc_mape` să fie evaluate pe istoric, iar botul trebuie să afișeze butoanele Da/Nu, cu Nu ca răspuns implicit.
- **Arm.** Numai cu aprobare explicită a suveranului.

## Canonul de bani, în cod
| Regulă | Unde |
|---|---|
| Unde UA e implicat: 50% Yunex, 50% RO; felia RO se împarte 50% Encon, 50% NrgPath | `tools/split.py` |
| Tranzit prin MD: partea NrgPath se împarte 50/50 cu WattMD (de confirmat) | `tools/split.py` |
| RO↔MD pur: 50% WattMD, 50% NrgPath | `tools/split.py` |
| Provizion CBAM: 40 €/MWh pentru origine UA, 30 €/MWh pentru origine MD, numai la intrarea în RO, în afara P/L | `tools/provision.py` |
| Limita de cumpărare: `(preț_UA − 0,9 − CBC − 0,5) / 1,01` | `tools/limits.py` |
| Un picior fără preț este unknown, niciodată 0; 0 € este un preț real | `tools/unknown.py` |
| CBC efectiv ponderat pe tranșe; F1 semnalează o plată dublă | `tools/cbc.py` |
| Registru numai cu adăugare, fiecare rând semnat HMAC și înlănțuit | `ledger/ledger.py` |

## Contract
Toate rutele cer antetul `X-RONOR-Token`. Dacă tokenul lipsește din configurare, serviciul refuză cererile.

| Rută | Rol |
|---|---|
| `POST /rxb/limits` | Tabelul limită/oră din forecast, CBC și NTC |
| `POST /rxb/forecast` | Înregistrează intrările postate în grup: NTC, forecast, CBC, vânzări |
| `POST /rxb/close` | Închiderea zilei: brut, provizion, împărțire, cumul RO |
| `POST /rxb/dispute-learn`, `POST /api/dispute` | Disputele; textul nu este parsat în cifre |
| `GET /api/ledger/verify` | Verificarea lanțului HMAC |
| `POST /api/nominate` | Răspunde 403 cât timp etapa nu este Arm |

## Acceptare
Comanda de acceptare este `bash ops/doctor.sh`. Etapele A, R, B și C trebuie să treacă toate. Cazurile înghețate sunt în `eval/cases/`.

## De confirmat cu validatorul
1. Tranzitul prin MD: împărțirea părții NrgPath cu WattMD.
2. Parametrii 0,9, 0,5 și 1,01: care este tariful, care este spread-ul minim și care este coeficientul de pierderi.
3. Valoarea-substituent 0,20: dacă un preț real de 0,20 € poate apărea vreodată.
