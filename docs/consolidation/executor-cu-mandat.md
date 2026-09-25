# Executorul cu mandat (lotul B, 25.09.2026; reparat după proba STOP)

Executorul cu mandat este singura cale prin care runtime-ul RONOR produce un efect pe o gazdă. Codul e în `src/runtime/executor/`, testele în `tests/executor/executor.test.ts`.

## Ce remediază

| Constatare | Descriere în registrul de remediere v6 | Ce face codul |
|---|---|---|
| F07, execuție fictivă | R-Execution declara „executed” pentru apeluri de unelte fără să existe un executor, iar planul raporta `healthy`. | `src/planes/r-execution` refuză apelurile de unelte cu `executor_unavailable`, `toolsInvoked` rămâne 0, iar sănătatea planului e `degraded`. Executorul produce starea `done` numai după terminarea procesului sau a cererii, cu cod de ieșire, și semnează o chitanță Ed25519 peste rezultat, cu cheia lui privată. |
| F09, citire care ascunde scrierea | Starea de citire putea ascunde o scriere eșuată. Registrul cerea stări distincte pentru citire și scriere, confirmare pe fiecare înregistrare și reluare idempotentă, fără dubluri. | Jurnalul SQLite are o înregistrare pe execuție, iar fiecare tranziție e confirmată prin numărul de rânduri schimbate. Nu există indicator global: `status()` dă ultima observare și ultima actuare separat. Aceeași aprobare nu produce o a doua execuție, ci întoarce rezultatul înregistrat. |
| F04, memoria ca instrucțiune | Conținutul din memorie putea deveni instrucțiune. Registrul cerea ca memoria să fie tratată ca date cu proveniență, cu revocare și contradicții tratate explicit. | Proveniența e în conținutul semnat al aprobării, nu în cerere: o aprobare cu proveniența `memory`, `model` sau `external` e refuzată și arsă, iar o cerere care declară `origin` e refuzată. Revocarea unui mandat sau a unei aprobări se aplică imediat, inclusiv pe o acțiune în curs. O a doua actuare pe aceeași unitate, cât timp prima e în curs, e refuzată ca acțiune contradictorie. |

Numerotarea F diferă între documente. În auditul complet din 23.09, aceleași trei constatări apar ca F07, F04 și F05. În `docs/consolidation/G0-G5` (auditul din 09.09), F09 este lease-ul pe arbore, F07 semnătura plicului, iar F04 sandboxul fără secrete. Codul acoperă și aceste variante:

- lease-ul executorului e persistent și reentrant pentru același deținător (G1.4);
- procesele pornite primesc un mediu minim, fără tokenuri și fără `DOCKER_HOST` (G1.2 și G1.3);
- mandatul și aprobarea sunt semnate Ed25519 de emitent, respectiv de omul care aprobă; executorul are numai cheile lor publice, iar chitanța are cheia privată proprie a executorului.

## Reparațiile după proba STOP (25.09.2026)

Proba pe gazdă (`rapoarte/2026-09-25-executor-proba-stop.md` în dosarul proiectului) a găsit șapte defecte. Reparațiile:

| Defect | Ce era | Ce face codul acum |
|---|---|---|
| D1 | La STOP, executorul ucidea numai clientul `systemctl start`. Jobul systemd continua, iar efectul final apărea după STOP, deși jurnalul spunea `interrupted`. | La STOP, revocare sau expirarea timpului, runner-ul oprește unitatea însăși: `systemctl stop -- <unit>`, apoi, dacă nu se confirmă, `systemctl kill --signal=SIGKILL -- <unit>`. După fiecare pas citește `ActiveState`. Starea `interrupted` se scrie numai după ce unitatea e `inactive` sau `failed`. Dacă oprirea nu se confirmă, starea e `interrupt_unconfirmed`. Niciuna nu are chitanță. |
| D2 | Lease-ul și verificarea contradicției priveau numai jurnalul. O aprobare nouă se putea alipi jobului rămas în curs după o întrerupere. | Înainte de orice actuare, executorul citește `systemctl show --property=ActiveState,SubState -- <unit>`. O unitate în `activating`, `deactivating` sau `reloading` e refuzată cu `unit_in_transition:<stare>`, iar aprobarea nu se consumă. Dacă starea nu se poate citi, actuarea e refuzată. |
| D3 | Mandatul, aprobarea și chitanța erau HMAC. `ronor-exec` citea cheile, deci își putea emite mandate și aprobări. | Semnături Ed25519. Emitentul mandatului și omul care aprobă dețin cheile private, în afara executorului. Executorul primește numai cheile lor publice și refuză un inel care conține o cheie privată. Cheia privată a executorului semnează numai chitanțe. Identificatorul cheii e amprenta cheii publice. Mandatul de operațiuni are versiunea `ronor-ops-mandate/v2`. Un mandat v1 (HMAC al runtime-ului de dezvoltare) nu e acceptat. |
| D4 | `origin` era un câmp liber al cererii. | `origin` intră în conținutul semnat al aprobării (`ronor-actuation-approval/v2`). O cerere care conține `origin` e refuzată cu `request_origin_field_forbidden`. O proveniență schimbată invalidează semnătura. O aprobare autentică cu altă proveniență decât `operator` e refuzată și arsă. |
| D5 | Lipsea dreptul de traversare pe `/etc/ronor`. | Pasul 3 din instalare. |
| D6 | CLI-ul nu emitea mandate, iar `action-hash` și `approve` deschideau jurnalul. | CLI-ul are `keygen`, `key-id` și `issue-mandate`. `action-hash`, `approve` și `issue-mandate` citesc numai catalogul și cheia privată a omului. Nu deschid jurnalul și nu citesc cheile executorului. |
| D7 | Construirea și rularea nu erau specificate. | Pașii 1 și 8 din instalare. |

Testele (`tests/executor/executor.test.ts`, `tests/executor/cli.test.ts`) folosesc o unitate fictivă care imită systemd (`tests/executor/fake-systemd.ts`). Procesul unității rulează în propria sesiune și în propriul grup de procese, separat de clientul `systemctl`. Un test arată că uciderea clientului lasă efectul să se producă, adică reproduce D1. Proba STOP verifică apoi efectul: procesul unității nu mai trăiește, marcajul final lipsește după trecerea întârzierii, iar starea e `inactive`.

## Porțile, în ordine

1. **STOP.** STOP-ul e persistent, păstrat în jurnal sau în fișierul `RONOR_EXECUTOR_STOP_FILE`. Cât e activ, nu pornește nimic.
2. **Proveniența.** Cererea nu o poate declara. Un câmp `origin` în cerere e refuzat. Pentru `ops.actuate`, proveniența e în aprobarea semnată și trebuie să fie `operator`. Pentru `ops.observe`, proveniența e mandatul semnat de emitent.
3. **Mandatul.** Se verifică semnătura Ed25519 a emitentului (`ronor-ops-mandate/v2`, cheie din inelul `RONOR_EXECUTOR_MANDATE_PUBKEYS_FILE`), validitatea pentru contextul gazdei (`ops://<host_id>`, `ops/<host_id>`), expirarea și revocarea.
4. **Acțiunea tipizată.** Tipul trebuie delegat de mandat (`ops_observe`, `ops_actuate`), iar argumentele trec lista albă a operatorului: `target` sau `device` și `command`, fiecare un identificator.
5. **Catalogul gazdei.** Ținta și verbul trebuie să existe în lista albă. Vectorul de argumente îl construiește executorul, fără shell și fără text liber.
6. **Aprobarea**, numai pentru `ops.actuate`. Obiectul e semnat Ed25519 de omul care aprobă, cu o cheie din inelul `RONOR_EXECUTOR_APPROVER_PUBKEYS_FILE`. Conține `action_hash`, adică SHA-256 peste forma canonică a acțiunii: gazdă, mandat, tip, argumente și resursă. Mai conține `mandate_id`, `origin`, `issued_at`/`expires_at`, cu cel mult 15 minute între ele, precum și `approval_id`, un nonce de unică folosință.
7. **Idempotența.** `approval_id` e cheie unică în jurnal.
8. **Contradicția și lease-ul.** Pe aceeași unitate poate rula o singură actuare. Lease-ul pe resursă e persistent.
9. **Starea unității.** O unitate în `activating`, `deactivating` sau `reloading` nu primește o actuare nouă.

Chiar înainte de pornire, STOP-ul se verifică din nou. În timpul execuției, STOP-ul și revocările se verifică la fiecare `stopPollMs`. Dacă apare oricare, clientul primește SIGTERM și, după 2 secunde, SIGKILL. În paralel, unitatea e oprită cu `systemctl stop`, iar dacă nu devine inactivă în 15 secunde, cu `systemctl kill --signal=SIGKILL`. Execuția se închide `interrupted` numai dacă `ActiveState` confirmă oprirea. Altfel se închide `interrupt_unconfirmed`. În ambele cazuri, motivul conține starea citită, de exemplu `stop_active:fișier;unit=inactive/dead`.

La repornirea procesului, o actuare rămasă `admitted` sau `started`, al cărei proces nu mai trăiește, devine `interrupt_unconfirmed`, iar o observare devine `interrupted`. Nu se reiau automat. O nouă încercare cere o nouă aprobare, iar poarta 9 o refuză cât unitatea e încă în tranziție. Un jurnal creat înainte de starea `interrupt_unconfirmed` e migrat la deschidere, cu înregistrările păstrate.

## Lista albă

Configurația gazdei e un fișier JSON validat strict (`parseExecutorCatalog`):

```json
{
  "host_id": "ronor-primara",
  "systemctl": ["/usr/bin/sudo", "-n", "/usr/bin/systemctl"],
  "entries": [
    { "id": "runtime", "type": "ops.observe", "kind": "http_get", "url": "http://127.0.0.1:3000/health", "timeout_ms": 5000 },
    { "id": "runtime-unit", "type": "ops.observe", "kind": "systemd_status", "unit": "ronor.service", "timeout_ms": 5000 },
    { "id": "runtime-unit", "type": "ops.actuate", "kind": "systemd", "unit": "ronor.service", "commands": ["restart"], "timeout_ms": 120000 }
  ]
}
```

Configurația e refuzată integral în oricare dintre aceste cazuri:

- are o cheie necunoscută;
- conține o unitate Docker, containerd, SSH, Tailscale, de firewall, `systemd-*`, `dbus`, `polkit`, `sudo`, `cron` sau `getty`;
- are o adresă care nu e pe loopback;
- conține credențiale în URL;
- folosește un binar care nu e `systemctl`;
- folosește `sudo` fără `-n`.

Verbele permise sunt numai `restart`, `start` și `stop`. Observarea `systemd` folosește numai `systemctl show`. Oprirea la STOP folosește numai `stop` și `kill --signal=SIGKILL` pe unitățile de actuare din catalog.

## Fără socket Docker

`MandatedExecutor.create` refuză să pornească dacă vede `DOCKER_HOST` sau dacă `/var/run/docker.sock` ori `/run/docker.sock` e accesibil pentru citire și scriere. Containerele se repornesc prin unitatea `systemd` care le deține, nu prin API-ul Docker.

## Cheile

| Cheie | Cine deține cheia privată | Unde stă cheia publică | Ce semnează |
|---|---|---|---|
| Emitentul mandatelor | omul sau autoritatea care emite mandate de operațiuni, în afara executorului | `/etc/ronor/executor/mandate-issuers.pub` | mandatele `ronor-ops-mandate/v2` |
| Aprobatorul | omul care aprobă, în afara executorului | `/etc/ronor/executor/approvers.pub` | aprobările `ronor-actuation-approval/v2` |
| Executorul | `ronor-exec`: `/etc/ronor/executor/receipt.key`, `root:ronor-exec 0640` | `/etc/ronor/executor/receipt.pub` | chitanțele `ronor-execution-receipt/v2` |

Cheile se generează cu `ronor-executor keygen <privată> <publică>`: cheia privată e scrisă cu modul 0600, nu se suprascrie o cheie existentă și nu se afișează. Fișierele `.pub` pot conține mai multe chei publice. Executorul refuză să pornească dacă un inel conține o cheie privată, dacă cheia chitanțelor apare într-un inel sau dacă aceeași cheie e în ambele inele. Cheile private ale emitentului și ale aprobatorului nu se pun pe gazda executorului. Pe serverul de probă au stat în `/root/aprobator/`, `root 0600`, ca să simuleze omul.

## Instalarea pe gazdă

1. **Construirea.** Pe gazdă trebuie instalat Node 20, aceeași linie cu imaginea `node:20-bookworm-slim` din `Dockerfile`, de exemplu `node-v20.x-linux-x64` de pe nodejs.org, cu SHA-256 verificat față de `SHASUMS256.txt`. Din `main`: `npm ci`, `npx tsc`, `npx jest tests/executor`. Sub `/opt/ronor-executor` se instalează:
   - `node/`, runtime-ul Node 20;
   - `app/dist/`, rezultatul construirii (`app/dist/runtime/executor/cli.js`);
   - `app/node_modules/`, din `npm ci --omit=dev` rulat pe gazdă, pentru că `better-sqlite3` e un modul nativ construit pentru acea gazdă și acea versiune de Node;
   - `bin/ronor-executor`, învelișul de mediu de la pasul 8;
   - `COMMIT`, commitul construit.
   Totul e `root:root`, fără drept de scriere pentru grup și ceilalți.
2. Creează utilizatorul de sistem `ronor-exec`, fără shell de autentificare și în afara grupului `docker`: `useradd --system --no-create-home --shell /usr/sbin/nologin --user-group ronor-exec`. Verifică: `id ronor-exec` nu arată `docker`.
3. **Dreptul de traversare pe `/etc/ronor`.** Pe gazdele reconstruite, `/etc/ronor` e `root:root 0700`. `ronor-exec` are nevoie numai de traversare, nu de listare: `setfacl -m u:ronor-exec:x /etc/ronor`. Modul lui `/etc/ronor` nu se schimbă, iar `pki/` și celelalte subdirectoare își păstrează drepturile. Verifică: `sudo -u ronor-exec test -r /etc/ronor/executor/catalog.json` și `sudo -u ronor-exec ls /etc/ronor` → `Permission denied`. `/etc/ronor/executor/` e `root:ronor-exec 0750`.
4. **Cheile**, ca în secțiunea „Cheile”: `mandate-issuers.pub`, `approvers.pub` și `receipt.pub` sunt `root:root 0644`, iar `receipt.key` e `root:ronor-exec 0640`. Cheile private ale emitentului și ale aprobatorului rămân la oameni.
5. Pune catalogul gazdei în `/etc/ronor/executor/catalog.json`, cu proprietar `root` și modul 0644. `ronor-exec` nu trebuie să-l poată modifica.
6. Adaugă regula `sudoers` îngustă, în `/etc/sudoers.d/ronor-executor`, validată cu `visudo -cf` înainte de a fi pusă la loc. Conține, pentru fiecare unitate de actuare, câte o linie pentru fiecare verb din catalog și liniile de oprire și de stare, exact cu argumentele pe care le construiește executorul:
   ```
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl restart -- ronor.service
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl stop -- ronor.service
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl kill --signal=SIGKILL -- ronor.service
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl show --property=ActiveState\,SubState -- ronor.service
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl show --property=ActiveState\,SubState\,MainPID\,NRestarts -- ronor.service
   ```
   Ultima linie e necesară numai dacă unitatea are și o intrare de observare. Liniile `stop` și `kill` sunt necesare chiar dacă `stop` nu e un verb din catalog: fără ele, STOP-ul nu poate opri efectul, iar execuția se închide `interrupt_unconfirmed`. Nu se folosesc metacaractere și nu se dă acces la `docker`.
7. Pregătește directorul jurnalului, `/var/lib/ronor-executor/`, cu proprietar `ronor-exec` și modul 0700. Fișierul de STOP e `/etc/ronor/executor/STOP`: îl creează `root`, iar `ronor-exec` îl poate numai citi.
8. **Învelișul de mediu**, `/opt/ronor-executor/bin/ronor-executor`, `root:root 0755`:
   ```sh
   #!/bin/sh
   unset DOCKER_HOST
   export RONOR_EXECUTOR_CATALOG=/etc/ronor/executor/catalog.json
   export RONOR_EXECUTOR_DB=/var/lib/ronor-executor/journal.db
   export RONOR_EXECUTOR_STOP_FILE=/etc/ronor/executor/STOP
   export RONOR_EXECUTOR_MANDATE_PUBKEYS_FILE=/etc/ronor/executor/mandate-issuers.pub
   export RONOR_EXECUTOR_APPROVER_PUBKEYS_FILE=/etc/ronor/executor/approvers.pub
   export RONOR_EXECUTOR_RECEIPT_KEY_FILE=/etc/ronor/executor/receipt.key
   exec /opt/ronor-executor/node/bin/node /opt/ronor-executor/app/dist/runtime/executor/cli.js "$@"
   ```
   Executorul rulează ca `sudo -u ronor-exec /opt/ronor-executor/bin/ronor-executor <comandă>`. Comenzile omului (`issue-mandate`, `action-hash`, `approve`) rulează în afara acestui înveliș, cu `RONOR_EXECUTOR_CATALOG` și cu `RONOR_MANDATE_ISSUER_KEY_FILE`, respectiv `RONOR_APPROVER_KEY_FILE`. Nu deschid jurnalul.
9. Fă proba pe gazdă înainte de orice actuare reală:
   - `status`;
   - o observare;
   - o actuare pe o unitate de probă, aprobată cu `approve`;
   - STOP prin fișier în timpul unei actuări lente, cu verificarea că efectul final lipsește și că unitatea e `inactive`;
   - o actuare peste o unitate aflată încă în pornire, care trebuie refuzată;
   - reluarea aceleiași aprobări, care nu trebuie să execute din nou;
   - o aprobare produsă de `ronor-exec` și o aprobare cu `origin` schimbat, ambele refuzate.

Până la acești pași, efectul există numai în cod și în teste. Runtime-ul din producție nu apelează executorul.

## Ce nu face încă

- Aprobarea prin Telegram nu e legată. Canalul `telegram` există în formatul aprobării, dar nu există încă un releu care să semneze.
- Executorul nu e chemat de bucla de dezvoltare și nici de runtime. Rămâne o unealtă pe care operatorul o rulează explicit.
- Liniile sudoers `stop` și `kill` îi permit lui `ronor-exec` să oprească unitățile de actuare fără aprobare. E o putere de oprire, nu de pornire, dar un proces compromis o poate folosi ca refuz de serviciu.
- Actuatoarele fizice, cu `dry_run` și compensare, și circuit-breaker-ul rămân în afara acestui lot.
