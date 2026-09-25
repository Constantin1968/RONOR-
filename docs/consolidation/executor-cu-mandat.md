# Executorul cu mandat (lotul B, 25.09.2026)

Executorul cu mandat este singura cale prin care runtime-ul RONOR produce un efect pe o gazdă. Codul e în `src/runtime/executor/`, testele în `tests/executor/executor.test.ts`.

## Ce remediază

| Constatare | Descriere în registrul de remediere v6 | Ce face codul |
|---|---|---|
| F07, execuție fictivă | R-Execution declara „executed” pentru apeluri de unelte fără să existe un executor, iar planul raporta `healthy`. | `src/planes/r-execution` refuză apelurile de unelte cu `executor_unavailable`, `toolsInvoked` rămâne 0, iar sănătatea planului e `degraded`. Executorul produce starea `done` numai după terminarea procesului sau a cererii, cu cod de ieșire, și semnează o chitanță HMAC peste rezultat. |
| F09, citire care ascunde scrierea | Starea de citire putea ascunde o scriere eșuată. Registrul cerea stări distincte pentru citire și scriere, confirmare pe fiecare înregistrare și reluare idempotentă, fără dubluri. | Jurnalul SQLite are o înregistrare pe execuție, iar fiecare tranziție e confirmată prin numărul de rânduri schimbate. Nu există indicator global: `status()` dă ultima observare și ultima actuare separat. Aceeași aprobare nu produce o a doua execuție, ci întoarce rezultatul înregistrat. |
| F04, memoria ca instrucțiune | Conținutul din memorie putea deveni instrucțiune. Registrul cerea ca memoria să fie tratată ca date cu proveniență, cu revocare și contradicții tratate explicit. | Executorul refuză orice cerere a cărei proveniență nu e `operator` (`memory`, `model`, `external`). Revocarea unui mandat sau a unei aprobări se aplică imediat, inclusiv pe o acțiune în curs. O a doua actuare pe aceeași unitate, cât timp prima e în curs, e refuzată ca acțiune contradictorie. |

Numerotarea F diferă între documente. În auditul complet din 23.09, aceleași trei constatări apar ca F07, F04 și F05. În `docs/consolidation/G0-G5` (auditul din 09.09), F09 este lease-ul pe arbore, F07 semnătura plicului, iar F04 sandboxul fără secrete. Codul acoperă și aceste variante:

- lease-ul executorului e persistent și reentrant pentru același deținător (G1.4);
- procesele pornite primesc un mediu minim, fără tokenuri și fără `DOCKER_HOST` (G1.2 și G1.3);
- mandatul e verificat prin semnătura autorității, iar aprobarea și chitanța au chei proprii, distincte.

## Porțile, în ordine

1. **STOP.** STOP-ul e persistent, păstrat în jurnal sau în fișierul `RONOR_EXECUTOR_STOP_FILE`. Cât e activ, nu pornește nimic.
2. **Proveniența.** Trece numai `origin: 'operator'`.
3. **Mandatul.** Se verifică semnătura autorității (`ronor-mandate/v1`), validitatea pentru contextul gazdei (`ops://<host_id>`, `ops/<host_id>`), expirarea și revocarea.
4. **Acțiunea tipizată.** Tipul trebuie delegat de mandat (`ops_observe`, `ops_actuate`), iar argumentele trec lista albă a operatorului: `target` sau `device` și `command`, fiecare un identificator.
5. **Catalogul gazdei.** Ținta și verbul trebuie să existe în lista albă. Vectorul de argumente îl construiește executorul, fără shell și fără text liber.
6. **Aprobarea**, numai pentru `ops.actuate`. Obiectul e semnat și conține `action_hash`, adică SHA-256 peste forma canonică a acțiunii: gazdă, mandat, tip, argumente și resursă. Conține și `mandate_id`, `issued_at`/`expires_at`, cu cel mult 15 minute între ele, precum și `approval_id`, un nonce de unică folosință.
7. **Idempotența.** `approval_id` e cheie unică în jurnal.
8. **Contradicția și lease-ul.** Pe aceeași unitate poate rula o singură actuare. Lease-ul pe resursă e persistent.

Chiar înainte de pornire, STOP-ul se verifică din nou. În timpul execuției, STOP-ul și revocările se verifică la fiecare `stopPollMs`. Dacă apare oricare, grupul de procese primește SIGTERM și, după 2 secunde, SIGKILL. Execuția se închide cu starea `interrupted`, fără chitanță de succes.

La repornirea procesului, o execuție rămasă `admitted` sau `started`, al cărei proces nu mai trăiește, devine `interrupted` și nu se reia automat. O nouă încercare cere o nouă aprobare.

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

Verbele permise sunt numai `restart`, `start` și `stop`, iar observarea `systemd` folosește numai `systemctl show`.

## Fără socket Docker

`MandatedExecutor.create` refuză să pornească dacă vede `DOCKER_HOST` sau dacă `/var/run/docker.sock` ori `/run/docker.sock` e accesibil pentru citire și scriere. Containerele se repornesc prin unitatea `systemd` care le deține, nu prin API-ul Docker.

## Instalarea pe gazdă (neinstalat la 25.09.2026)

1. Construiește runtime-ul din `main`. Rezultatul, `dist/runtime/executor/cli.js`, se instalează sub `/opt/ronor-executor`.
2. Creează utilizatorul de sistem `ronor-exec`, fără shell de autentificare și în afara grupului `docker`. Verifică: `id ronor-exec` nu arată `docker`.
3. Creează cheile, fiecare de cel puțin 32 de octeți și diferită de celelalte: mandat, aprobare și chitanță. Cheia de mandat e aceeași cu cea a autorității de mandate a runtime-ului. Pune-le în `/etc/ronor/executor/`, cu proprietar `root:ronor-exec` și modul 0640. Cheia de aprobare o deține numai omul care aprobă.
4. Pune catalogul gazdei în `/etc/ronor/executor/catalog.json`, cu proprietar `root` și modul 0644. `ronor-exec` nu trebuie să-l poată modifica.
5. Adaugă regula `sudoers` îngustă, în `/etc/sudoers.d/ronor-executor`, validată cu `visudo -cf`. Conține câte o linie pentru fiecare pereche verb-unitate din catalog, exact cu argumentele pe care le construiește executorul:
   ```
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl restart -- ronor.service
   ronor-exec ALL=(root) NOPASSWD: /usr/bin/systemctl show --property=ActiveState\,SubState\,MainPID\,NRestarts -- ronor.service
   ```
   Nu se folosesc metacaractere și nu se dă acces la `docker`.
6. Pregătește directorul jurnalului, `/var/lib/ronor-executor/`, cu proprietar `ronor-exec` și modul 0700. Fișierul de STOP e `/etc/ronor/executor/STOP`: îl creează `root`, iar `ronor-exec` îl poate numai citi.
7. Setează mediul: `RONOR_EXECUTOR_CATALOG`, `RONOR_EXECUTOR_DB`, `RONOR_EXECUTOR_STOP_FILE`, `RONOR_EXECUTOR_MANDATE_KEY_FILE`, `RONOR_EXECUTOR_APPROVAL_KEY_FILE`, `RONOR_EXECUTOR_RECEIPT_KEY_FILE`. Nu seta `DOCKER_HOST`.
8. Fă proba pe gazdă înainte de orice actuare reală:
   - `status`;
   - o observare;
   - o actuare pe o unitate de probă, aprobată cu `approve`;
   - STOP prin fișier în timpul unei actuări lente;
   - reluarea aceleiași aprobări, care nu trebuie să execute din nou.

Până la acești pași, efectul există numai în cod și în teste. Runtime-ul din producție nu apelează executorul.

## Ce nu face încă

- Aprobarea prin Telegram nu e legată. Canalul `telegram` există în formatul aprobării, dar nu există încă un releu care să semneze.
- Executorul nu e chemat de bucla de dezvoltare și nici de runtime. Rămâne o unealtă pe care operatorul o rulează explicit.
- Actuatoarele fizice, cu `dry_run` și compensare, și circuit-breaker-ul rămân în afara acestui lot.
