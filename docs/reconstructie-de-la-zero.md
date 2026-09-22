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

## 2. Directoare care trebuie să existe pe gazdă

Rădăcina este `/srv/ronor/development-automation`, cu subdirectoare distincte pentru codul de
instalare, arborele de lucru, dependențe, dovezi, contoare unice, baza de date și acreditările
de serviciu.

Registrul persistent de buget se află la
`/srv/ronor/development-automation/model-budget/ledger.db`. Directorul său cere proprietar
`10001:10001` și mod `0700`.

Niciun manifest nu creează aceste directoare. Instalatoarele le presupun existente.

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
| 8 | `docker-compose.development-egress.yml` | 7 |
| 9 | `docker-compose.development-transport.yml` | 7 |
| 10 | `docker-compose.development-context.yml` | 6 |
| 11 | `docker-compose.development-artifact.yml` | 5 |
| 12 | `docker-compose.development-evidence-home.yml` | 4 |
| 13 | `docker-compose.development-planner-fix.yml` | 2 |
| 14 | `docker-compose.development-diagnostics.yml` | 1 |
| 15 | `docker-compose.development-runtime-window.yml` | 1 |

**Ambiguitate rămasă, declarată ca atare.** Pozițiile 8 și 9 sunt la egalitate. Niciun
instalator nu le include pe amândouă într-o ordine care să tranșeze întrebarea, deci ordinea
dintre ieșirea controlată către modele și transport nu se poate stabili din depozit. Se
lămurește numai din istoricul de aplicare de pe gazda vie. Până atunci, o reconstrucție trebuie
să considere acest punct un risc deschis, nu o certitudine.

## 4. Două suprapuneri care nu apar în nicio listă de manifeste

Ambele sunt accesibile, dar nu prin argumentul `-f` al unui instalator, iar acest lucru nu era
scris nicăieri:

- `docker-compose.development-controller.yml` este consumat prin `extends:` de
  `docker-compose.development-isolated.yml`. Este totodată o instalație separată, opțională,
  descrisă în `docs/development-controller.md`: leagă controlorul numai la rețeaua internă,
  publică exclusiv `127.0.0.1:3010`, nu montează socketul Docker și nu primește chei.
- `docker-compose.development-existing-verification.yml` este o suprapunere aplicată prin
  procedura din `docs/verify-existing-commit.md`, nu prin instalatoarele de dezvoltare.

Cine reconstruiește urmărind doar tabelul din secțiunea 3 le va rata pe amândouă.

## 5. Variabile: cine le stabilește

Șaisprezece variabile sunt obligatorii și nu au valori implicite. Ele se împart în două clase
care nu trebuie confundate.

**Stabilite de operator.** Se află în șabloanele de mediu ale depozitului —
`.env.example`, `.env.production.template`, `.env.automation.template`,
`.env.development.example`. Aici intră `RONOR_AUTOMATION_SECRET_DIR`,
`RONOR_DEVELOPMENT_SECRET_DIR`, `REDIS_PASSWORD`, `OPENAI_API_KEY`, `RONOR_ADMIN_API_KEY` și
`RONOR_API_KEYS`.

**Derivate de instalatoare.** Nu se scriu de mână niciodată. Fiecare instalator le calculează
din revizia instalată și le persistă într-un fișier propriu sub rădăcina de pe gazdă, de unde
instalatoarele următoare le recitesc.

| Variabile | Scrise de | Persistate în |
| --- | --- | --- |
| `RONOR_BUDGET_SOURCE`, `RONOR_BUDGET_TAG` | `install-development-budget.sh` | `budget.env` |
| `RONOR_ARTIFACT_SOURCE`, `RONOR_ARTIFACT_TAG` | `install-development-artifact-fix.sh` | `artifact.env` |
| `RONOR_CONTEXT_SOURCE`, `RONOR_CONTEXT_TAG` | `install-development-context-fix.sh` | `context.env` |
| `RONOR_WIREFIX_SOURCE`, `RONOR_WIREFIX_TAG` | `install-development-wire-fix.sh` | `wirefix.env` |
| `RONOR_RECOVERY_FIX_SOURCE`, `RONOR_RECOVERY_FIX_TAG` | `install-development-recovery.sh` | `recovery-fix.env` |

Consecința practică: aceste zece variabile lipsesc din șabloane **corect**. Ele nu sunt însă
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
