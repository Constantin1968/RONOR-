# Reconstrucția de la zero, pe o gazdă curată

Acest document este indexul de reconstrucție. Până acum depozitul conținea toate rețetele
necesare, dar niciun loc în care să fie scris în ce ordine se aplică, ce trebuie să existe pe
gazdă înaintea primei rețete și care variabile sunt stabilite de operator față de care sunt
derivate de instalatoare. Ordinea exista implicit, în listele de manifeste compuse de fiecare
instalator; aici este scrisă explicit.

Nicio rețetă nu a fost modificată. Documentul descrie comportamentul actual.

---

## 1. Punctul de intrare este obligatoriu

`scripts/automation-bootstrap.sh` se rulează primul, întotdeauna. El creează cele trei rețele
de containere care sunt declarate **externe** în manifeste și care deci trebuie să existe
înainte ca prima rețetă să fie aplicată:

| Rețea | Nume real pe gazdă | Rutare |
| --- | --- | --- |
| `automation-control` | `ronor-automation-control` | internă, fără rută în afara gazdei |
| `model-egress` | `ronor-model-egress` | internă, fără rută în afara gazdei |
| `model-uplink` | `ronor-model-uplink` | singura rutabilă spre exterior |

Pe o gazdă curată, orice `docker compose up` executat înaintea acestui script eșuează imediat,
fiindcă Docker refuză o rețea externă inexistentă. Eșecul nu indică un defect al rețetei.

## 2. Directoare pe gazdă: cine le creează

Rădăcina este `/srv/ronor/development-automation`, cu subdirectoare distincte pentru codul de
instalare, arborele de lucru, dependențe, dovezi, contoare unice, baza de date și acreditările
de serviciu.

Registrul persistent de buget se află la
`/srv/ronor/development-automation/model-budget/ledger.db`. Directorul său cere proprietar
`10001:10001` și mod `0700`.

Niciun manifest compose nu creează aceste directoare. Le creează însă instalatoarele:

- `scripts/install-development-isolated.sh` (liniile 21–33) creează rădăcina și `tooling/` cu
  `mkdir -m 0750`, copiază `tooling/` în `worktree/`, creează `secrets/`, `artifacts/`,
  `nonces/`, `data/` și `dependencies/` cu `mkdir -m 0700` și le atribuie, împreună cu
  `worktree/`, proprietarul `10001:10001`;
- `scripts/install-development-budget.sh` (linia 45) creează `model-budget/` cu
  `install -d -m 0700 -o 10001 -g 10001`.

Directoarele nu trebuie deci create de mână înainte. Dimpotrivă, unele instalatoare refuză să
ruleze dacă directorul există deja: `install-development-isolated.sh` rulează cu
`set -Eeuo pipefail` și se oprește la `mkdir` pe o rădăcină existentă, iar
`install-development-budget.sh` se oprește cu `budget_install_exists_review_required` dacă
`budget.env` sau `model-budget/` există.

## 3. Ordinea de aplicare a suprapunerilor

Derivată din listele de manifeste pe care le compune fiecare instalator: un manifest inclus de
mai multe instalatoare se află mai jos în stivă.

| # | Suprapunere | Inclusă în |
| --- | --- | --- |
| 1 | `docker-compose.development-isolated.yml` | 14 din 16 instalatoare |
| 2 | `docker-compose.development-verification-fix.yml` | 13 |
| 3 | `docker-compose.development-controller-fix.yml` | 12 |
| 4 | `docker-compose.development-accounting-fix.yml` | 11 |
| 5 | `docker-compose.development-budget.yml` | 10 |
| 6 | `docker-compose.development-recovery.yml` | 9 |
| 7 | `docker-compose.development-wirefix.yml` | 8 |
| 8 | `docker-compose.development-transport.yml` | 7 |
| 9 | `docker-compose.development-egress.yml` | 7 |
| 10 | `docker-compose.development-context.yml` | 6 |
| 11 | `docker-compose.development-artifact.yml` | 5 |
| 12 | `docker-compose.development-evidence-home.yml` | 4 |
| 13 | `docker-compose.development-planner-fix.yml` | 2 |
| 14 | `docker-compose.development-diagnostics.yml` | 1 |
| 15 | `docker-compose.development-runtime-window.yml` | 1 |

**Pozițiile 8 și 9.** Numărul de instalatoare e egal (7), dar ordinea se tranșează din
depozit: `scripts/install-development-egress.sh`, linia 13, se oprește cu
`transport_overlay_missing` dacă `transport.env` nu există. Transportul (8) se aplică deci
înaintea ieșirii controlate către modele (9).

## 4. Trei suprapuneri care nu apar în nicio listă de manifeste

Niciuna nu se aplică prin argumentul `-f` al unui instalator, iar acest lucru nu era scris
nicăieri:

- `docker-compose.development-controller.yml` este consumat prin `extends:` de
  `docker-compose.development-isolated.yml`. Este totodată o instalație separată, opțională,
  descrisă în `docs/development-controller.md`: leagă controlorul numai la rețeaua internă,
  publică exclusiv `127.0.0.1:3010`, nu montează socketul Docker și nu primește chei.
- `docker-compose.development-existing-verification.yml` este o suprapunere aplicată prin
  procedura din `docs/verify-existing-commit.md`, nu prin instalatoarele de dezvoltare.
- `docker-compose.development-codex-release.yml` este **orfană**: nu e referită de niciun
  script și de niciun document din depozit. Antetul ei cere aplicarea ultima („Apply LAST”) și
  redefinește numai serviciul `codex-verifier`, construit din aceeași revizie ca și controlorul
  (`RONOR_EXISTING_VERIFY_SOURCE`, `RONOR_EXISTING_VERIFY_TAG`). Folosește deci variabilele
  procedurii din `docs/verify-existing-commit.md`, dar procedura nu o menționează. Până când
  o procedură o descrie explicit, nu face parte din reconstrucție.

Cine reconstruiește urmărind doar tabelul din secțiunea 3 le va rata pe toate trei.

## 5. Variabile: cine le stabilește

Fișierele compose conțin în total 53 de variabile obligatorii distincte, scrise ca
`${VAR:?}`, fără valoare implicită. Ele se împart în două clase care nu trebuie confundate.

**Stabilite de operator.** Se află în șabloanele de mediu ale depozitului —
`.env.example`, `.env.production.template`, `.env.automation.template`,
`.env.development.example`. Printre ele: `RONOR_AUTOMATION_SECRET_DIR`,
`RONOR_DEVELOPMENT_SECRET_DIR`, `REDIS_PASSWORD`, `OPENAI_API_KEY`, `RONOR_ADMIN_API_KEY` și
`RONOR_API_KEYS`.

**Derivate de instalatoare.** Nu se scriu de mână niciodată. Fiecare instalator le calculează
din revizia instalată și le persistă într-un fișier propriu sub rădăcina de pe gazdă, de unde
instalatoarele următoare le recitesc.

Paisprezece instalatoare scriu câte un fișier `*.env` în `/srv/ronor/development-automation`,
în ordinea în care se aplică:

| Variabile | Scrise de | Persistate în |
| --- | --- | --- |
| `RONOR_VERIFICATION_FIX_SOURCE`, `RONOR_VERIFICATION_FIX_TAG` | `install-development-verification-fix.sh` | `verification-fix.env` |
| `RONOR_CONTROLLER_FIX_SOURCE`, `RONOR_CONTROLLER_FIX_TAG` | `install-development-controller-fix.sh` | `controller-fix.env` |
| `RONOR_ACCOUNTING_FIX_SOURCE`, `RONOR_ACCOUNTING_FIX_TAG` | `install-development-accounting-fix.sh` | `accounting-fix.env` |
| `RONOR_BUDGET_SOURCE`, `RONOR_BUDGET_TAG` | `install-development-budget.sh` | `budget.env` |
| `RONOR_RECOVERY_FIX_SOURCE`, `RONOR_RECOVERY_FIX_TAG` | `install-development-recovery.sh` | `recovery-fix.env` |
| `RONOR_WIREFIX_SOURCE`, `RONOR_WIREFIX_TAG` | `install-development-wire-fix.sh`; rescris de `install-development-budget-concurrency.sh` | `wirefix.env` |
| `RONOR_TRANSPORT_SOURCE`, `RONOR_TRANSPORT_TAG` | `install-development-transport.sh` | `transport.env` |
| `RONOR_EGRESS_SOURCE`, `RONOR_EGRESS_TAG` | `install-development-egress.sh` | `egress.env` |
| `RONOR_CONTEXT_SOURCE`, `RONOR_CONTEXT_TAG` | `install-development-context-fix.sh` | `context.env` |
| `RONOR_ARTIFACT_SOURCE`, `RONOR_ARTIFACT_TAG` | `install-development-artifact-fix.sh` | `artifact.env` |
| `RONOR_EVIDENCE_HOME_SOURCE`, `RONOR_EVIDENCE_HOME_TAG` | `install-development-evidence-home.sh` | `evidence-home.env` |
| `RONOR_PLANNER_FIX_SOURCE`, `RONOR_PLANNER_FIX_TAG` | `install-development-planner-fix.sh` | `planner-fix.env` |
| `RONOR_DIAGNOSTICS_SOURCE`, `RONOR_DIAGNOSTICS_TAG` | `install-development-diagnostics.sh` | `diagnostics.env` |
| `RONOR_AUTOMATION_MAX_RUNTIME_MINUTES` (suprascriere aprobată, numai valoarea 45) | `install-development-runtime-window.sh` | `runtime-window.env` |

În total: 26 de variabile derivate din revizia instalată (perechile `*_SOURCE` și `*_TAG` din
13 fișiere) și o suprascriere, `RONOR_AUTOMATION_MAX_RUNTIME_MINUTES`, a cărei valoare
implicită se află în `.env.development.example`, iar valoarea aprobată în `runtime-window.env`.

Separat de instalatoare, `RONOR_EXISTING_VERIFY_SOURCE`, `RONOR_EXISTING_VERIFY_TAG` și
`RONOR_EXISTING_VERIFY_HEAD` sunt stabilite de procedura din `docs/verify-existing-commit.md`,
pentru `docker-compose.development-existing-verification.yml` (și pentru suprapunerea orfană
`docker-compose.development-codex-release.yml`, secțiunea 4).

Consecința practică: aceste variabile lipsesc din șabloane **corect**. Ele nu erau însă
documentate nicăieri ca fiind derivate, iar absența lor din șabloane arăta, la o citire
rezonabilă, ca o omisiune. Tabelul de mai sus închide întrebarea.

## 6. Reproductibilitate

`docker-compose.production.yml` fixa imaginea `certbot` pe eticheta mobilă `latest`. Într-un
depozit a cărui întreagă rațiune este reconstrucția identică, aceasta era o contradicție
internă: o reconstrucție de azi și una de peste șase luni ar fi produs sisteme diferite din
aceleași rețete. Imaginea este acum fixată pe `v5.8.0`.

---

## Ce nu dovedește acest document

Nimic din depozit nu a fost executat pentru a produce tabelele de mai sus. Ele sunt derivate
static din conținutul rețetelor și al instalatoarelor. Un control care verifică zilnic rețetele
fără a le executa niciodată nu poate demonstra reconstruibilitatea; nici acest index nu o
demonstrează. Prima reconstrucție reală, pe o gazdă curată, rămâne singura dovadă.

---

*NrgPaths Advisory Ltd*
