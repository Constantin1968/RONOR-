# Reconstrucția gazdei primare (ronor-sovereign, DigitalOcean): dependențele declarate

Acest document completează `docs/reconstructie-de-la-zero.md`, care descrie gazda secundară și
automatizarea dezvoltării. Aici este gazda primară: runtime-ul RONOR, Qdrant, Redis și Postgres.

**De unde vine lista.** La 25 septembrie 2026, gazda primară a fost reconstruită pe o gazdă de
probă curată, din `main@1143201` și din copiile existente. Cele patru containere au fost
sănătoase, cu numărători identice și după repornire. Criteriul de audit „restaurare pe gazdă
nouă, fără dependențe nedeclarate” a rămas însă deschis: reconstrucția a mers numai după
acoperirea a **opt dependențe nedeclarate** și a **șase pași manuali**. Niciuna nu era în
depozit, în rețeta colectată de pe gazdă (39 de fișiere) sau în vreun script.

Acest document le declară pe toate opt. Pentru fiecare spune ce este, unde e declarată acum
și ce rămâne de făcut. Declararea nu închide singură criteriul: închiderea cere o nouă
reconstrucție pe gazdă curată, făcută numai din depozit și din rețete.

Adresele gazdelor nu sunt scrise aici, pentru că depozitul e public. Ele sunt în rețetele
private ale proiectului (`infrastructura/retete/ronor-sovereign/`). În text apar ca
`<TAILSCALE_PRIMARA>` (adresa Tailscale a primarei), `<TAILSCALE_SECUNDARA>` (adresa Tailscale
a gazdei secundare) și `<IP_PUBLIC_SECUNDARA>`.

---

## Rezumat

| # | Dependența | Declarată acum în | Rămâne |
|---|---|---|---|
| 1 | Suprapunerea `docker-compose.runtime-override.yml` și `Dockerfile.runtime` | `ops/ronor-sovereign/lansare/`, `ops/ronor-sovereign/pregateste-lansare.sh` | colectarea lansării curente pe gazdă |
| 2 | Compose-ul de producție cu TLS pentru Qdrant | `docker-compose.production.yml` pe `main` (PR #48, `2e3d9a5`) | instalarea pe gazdă |
| 3 | Autoritatea internă `/etc/ronor/pki` | `ops/ronor-sovereign/emite-pki-intern.sh` | `ca.key` în arhiva de secrete |
| 4 | Valorile nesecrete din `.env.production` | secțiunea 4 de mai jos | eliminarea setării moarte `RONOR_KNOWLEDGE_SOURCES` |
| 5 | Rețeaua externă `app_default` și cele trei proiecte compose | secțiunea 5, ordinea pornirii | un singur proiect compose |
| 6 | Adresa Tailscale a primarei | `ops/ronor-sovereign/docker-compose.postgres-legare.yml` și `docker-compose.postgres-local.yml` | reorientarea consumatorilor, scrisă ca procedură |
| 7 | Scripturile din `/usr/local/sbin` și crontab-ul lui root | secțiunea 7 | `trage-cida-de-pe-hetzner.sh` și crontab-ul lui root în rețetă |
| 8 | Serviciul gazdei `ronor.service` | secțiunea 8 | colectarea `/opt/ronor/main.py`, a mediului virtual și a configurației |

---

## 1. Suprapunerea lansării și `Dockerfile.runtime`

Runtime-ul din producție pornește cu:

```
docker compose -p ronor-sovereign \
  -f docker-compose.production.yml -f docker-compose.runtime-override.yml \
  --env-file .env.production up -d ronor
```

`docker-compose.runtime-override.yml` nu era în git. Colectorul de rețete exclude `/releases/`,
deci nu era nici în rețetă. Fișierul fusese copiat din lansare în lansare încă din 21 august.
Fără el:

- construirea nu folosește `Dockerfile.runtime`;
- runtime-ul nu intră în rețeaua `app_default` (dependența 5);
- compose creează volume noi, goale, în locul lui `ronor-data` (lanțul de audit) și
  `app_redis-data`.

**Declarat acum:** `ops/ronor-sovereign/lansare/docker-compose.runtime-override.yml`, identic
octet cu octet cu fișierul din producție de la lansarea `1143201`
(sha256 `68565a386105c842253363b7fd2f00109e34ff1b0b7f2de23c79e49e2b8453a7`).

`Dockerfile.runtime` era o copie făcută de mână a lui `Dockerfile`. Scriptul
`ops/ronor-sovereign/pregateste-lansare.sh <revizie> <director>` face acum tot pasul manual 1:
`git archive` pe revizie, suprapunerea din depozit, `Dockerfile.runtime` copiat din
`Dockerfile`-ul acelei revizii și `REVISION`. Refuză un director existent. La sfârșit afișează
amprentele fișierelor și valoarea pe care trebuie să o aibă `RONOR_VERSION`. Nu scrie mediul,
nu construiește și nu pornește nimic.

Construirea e reproductibilă numai dacă `Dockerfile` folosește `npm ci` cu `package-lock.json`
(cererea separată pentru Dockerfile). Copia `Dockerfile.runtime` preia automat schimbarea.

## 2. Compose-ul de producție cu TLS

Fișierul care rula nu era cel din `main`, ci o modificare locală din 4 septembrie, cu TLS
pentru Qdrant și încredere în autoritatea internă. Rețeta avea o variantă și mai veche, fără
TLS. **Declarat acum:** modificarea e pe `main` prin PR #48 (`2e3d9a5`), cu montarea strictă a
lui `qdrant.crt` și `qdrant.key` și `QDRANT_URL` pe `https`. Nu e încă instalată pe gazdă.

## 3. Autoritatea internă `/etc/ronor/pki`

`ca.crt`, `ca.key`, `qdrant.crt` și `qdrant.key` nu apăreau în rețete, în copii sau în vreun
script. La pierderea gazdei, autoritatea se pierdea. Pe probă au fost generate din nou, cu
aceleași SAN-uri.

**Declarat acum:** `ops/ronor-sovereign/emite-pki-intern.sh`.

- `ca-nou <dir-ca>`: CA nouă (RSA 4096, 10 ani) și certificatul Qdrant (RSA 2048, 2 ani), cu
  SAN `qdrant`, `ronor-qdrant`, `localhost`, `127.0.0.1`.
- `qdrant <dir-ca>`: numai un certificat Qdrant nou, semnat de CA existentă (reînnoirea).
- În `/etc/ronor/pki` rămân numai `ca.crt` (644), `qdrant.crt` (644) și `qdrant.key` (640).
  Scriptul refuză să țină `ca.key` în acel director, pentru că e montat în containere
  (constatarea din lotul D, 25.09.2026), și șterge un `ca.key` rămas acolo.
- `ca.key` (600) stă în directorul dat ca argument, numai pentru root, și trebuie pus în
  arhiva de secrete.

## 4. Valorile nesecrete din `.env.production`

Șablonul este `.env.production.template`. Valorile reale nu sunt în rețete, corect, fiindcă
multe sunt secrete. Trei valori nesecrete de care depinde funcționarea nu erau însă scrise
nicăieri:

| Cheie | Valoare în producție | De ce contează |
|---|---|---|
| `RONOR_VERSION` | primele 7 caractere ale reviziei lansate (azi `1143201`) | numește imaginea `ronor:${RONOR_VERSION}`; valoarea implicită din compose e `0.5.0`, iar la 25.09 runtime-ul a pornit două minute pe imaginea veche din acest motiv |
| `KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION` | `container` (ca în șablon) | fără ea, sănătatea stratului de cunoaștere cere configurarea (`src/knowledge/deployment-health.ts`) |
| `RONOR_KNOWLEDGE_SOURCES` | `/opt/ronor/app/knowledge-sources.json` | **setare moartă**: calea e pe gazdă și nu e montată în container, deci fișierul nu există acolo nici în producție. De eliminat sau de montat explicit |

Tot din mediu reiese `/opt/ronor/app/.env`, al proiectului `app`, cu `POSTGRES_PASSWORD` și
`POSTGRES_BIND_ADDR`. Compose-ul de pe gazdă nu folosește a doua valoare (dependența 6).

Chei cu valoare comună în producție, care trebuie rotite împreună: `OPENAI_API_KEY` și
`RONOR_GATEWAY_API_KEY`; `KNOWLEDGE_QDRANT_API_KEY` și `QDRANT_API_KEY`; `REDIS_PASSWORD` și
parola din `REDIS_URL`.

## 5. Rețeaua `app_default` și cele trei proiecte compose

În producție, cele patru containere vin din trei proiecte compose diferite:

| Container | Proiect | Fișier |
|---|---|---|
| `ronor-postgres` | `app` | `/opt/ronor/app/docker-compose.yml` |
| `ronor-redis` | lansarea `v0.5.0-20260819` | compose-ul acelei lansări |
| `ronor-qdrant` | `app` (fișierul de producție) | `/opt/ronor/app/docker-compose.production.yml` |
| `ronor-runtime` | `ronor-sovereign` | lansarea curentă, cu suprapunerea de la punctul 1 |

Suprapunerea declară `app_default` ca rețea **externă**, care apare numai dacă proiectul
`app` a pornit primul. Comanda de compose a runtime-ului nu recreează, deci, Postgres.
Runtime-ul nu folosește Postgres (nu are `DATABASE_URL`, iar `SUPABASE_DB_URL` e gol); baza
e folosită de planurile de pe gazda secundară.

**Ordinea pornirii, pe o gazdă curată:**

1. proiectul `app`, numai `postgres`, care creează `app_default`;
2. restaurarea bazei din `ronor-do-<data>.dump` și a rolurilor din `ronor-do-globals-<data>.sql`
   (rolul `ronor_app` se creează fără parolă, copia se face cu `--no-role-passwords`);
3. `qdrant` și `redis`, din proiectul `ronor-sovereign`;
4. recrearea colecțiilor Qdrant din configurația exportată (nu există copie Qdrant; vezi
   „Ce nu e acoperit”);
5. `audit.db` în volumul `ronor-data`, după ștergerea fișierelor `-wal` și `-shm`;
6. runtime-ul.

## 6. Adresa Tailscale a primarei

- Compose-ul `app` de pe gazdă publică 5432 pe `127.0.0.1` și pe `<TAILSCALE_PRIMARA>`, scrisă
  direct. Pe o gazdă fără această adresă legarea portului eșuează și Postgres nu pornește.
- Consumatorii de pe gazda secundară (`r-execute`, `r-schedule`, `r-monitor`) ajung la bază și
  la runtime (prin `ronor-sonda-runtime.socket`, lotul D) prin această adresă.
- Poarta de modele (`RONOR_GATEWAY_BASE_URL`, `OPENAI_API_BASE`) este Portkey pe gazda
  secundară, la `<TAILSCALE_SECUNDARA>`.

**Declarat acum:**

- `ops/ronor-sovereign/docker-compose.postgres-legare.yml`: adresa Tailscale devine variabila
  obligatorie `POSTGRES_TAILNET_ADDR`; `127.0.0.1` rămâne.
- `ops/ronor-sovereign/docker-compose.postgres-local.yml`: numai `127.0.0.1`, pentru o gazdă
  care nu e încă în tailnet.

`docker-compose.yml` din depozit folosea deja `${POSTGRES_BIND_ADDR:-127.0.0.1}`; fișierul de
pe gazdă e o variantă mai veche.

**Procedura pentru o primară nouă:** alăturarea la tailnet cu aceeași adresă (sau o adresă
nouă și reorientarea tuturor consumatorilor de mai sus); regula `ronor-docker-firewall.sh`
pentru 5432 (dependența 7), care permite explicit `<IP_PUBLIC_SECUNDARA>`; filtrul Tailscale
din lotul D (`ronor-tailnet-filtru`).

## 7. Scripturile din `/usr/local/sbin` și crontab-ul lui root

Rețeta avea `cron.d/ronor-db-dump`, `cron.d/ronor-acces-nou` și
`ronor-docker-firewall.service`, dar nu scripturile pe care acestea le apelează.

| Script | Apelat de | Rol |
|---|---|---|
| `ronor-db-dump.sh` | `cron.d/ronor-db-dump`, 02:00 UTC | `pg_dump -Fc`, globals și copia online a lui `audit.db`, în `/opt/ronor/dbdump`, preluate de gazda secundară |
| `ronor-copie-sqlite.py` | `ronor-db-dump.sh` | copia consistentă a bazelor SQLite |
| `ronor-docker-firewall.sh` | `ronor-docker-firewall.service` | restricția pe 5432 în lanțul `DOCKER-USER` |
| `ronor-acces-nou.sh` | `cron.d/ronor-acces-nou`, la 15 minute | alarma de acces din origine necunoscută |
| `ronor-config-incorporare.sh` | manual | configurația de încorporare |
| `trage-cida-de-pe-hetzner.sh` | crontab-ul lui root, 03:10 | copia CIDA trasă de pe gazda secundară |

Starea la 25.09.2026, 20:33 EEST: colectorul de rețete a fost corectat în lotul D ca să
includă `/usr/local/sbin/ronor-*`, iar primele cinci scripturi sunt acum în rețeta privată a
primarei. `trage-cida-de-pe-hetzner.sh` nu începe cu `ronor-`, iar crontab-ul lui root nu e
citit de colector (acesta citește numai `/etc/cron.d`). **Rămâne:** includerea lor explicită
în colector. Scripturile nu sunt copiate în acest depozit public, pentru că conțin adrese și
reguli de rețea ale gazdelor.

## 8. Serviciul gazdei `ronor.service`

„RONOR Memory & Alert Engine”, activ în producție, rulează
`/opt/ronor/venv/bin/python3 /opt/ronor/main.py` cu `EnvironmentFile=/opt/ronor/config/ronor.env`.
Rețeta are numai unitatea systemd. `main.py`, mediul virtual și configurația nu sunt colectate.
Serviciul nu face parte din niciun proiect compose și nu a fost reconstruit pe probă, pentru
că poate trimite alerte Telegram.

**Rămâne:** colectarea lui `main.py` și a unei liste de pachete fixate
(`pip freeze` din `venv`), cu `ronor.env` numai în arhiva de secrete; apoi decizia dacă
serviciul mai e necesar.

---

## Pașii manuali, acum scriși

| Pas manual din reconstrucția pe probă | Acum |
|---|---|
| 1. Crearea lansării (arhivă, compose, suprapunere, `Dockerfile.runtime`, `REVISION`) | `pregateste-lansare.sh` |
| 2. Emiterea autorității interne și a certificatului Qdrant | `emite-pki-intern.sh ca-nou` |
| 3. Porturile lui Postgres fără adresa Tailscale | `docker-compose.postgres-local.yml` |
| 4. Ordinea pornirii | secțiunea 5 |
| 5. Restaurarea `audit.db` (fără `-wal`/`-shm`; cheile API ale producției dezactivate pe altă gazdă) | secțiunea 5, pasul 5 |
| 6. Generarea mediului | secțiunea 4; valorile secrete vin din arhiva de secrete, nu din depozit |

## Ce nu e acoperit

- **Nu există copie Qdrant.** Volumul de instantanee e gol și niciun script nu face
  instantanee. Azi pierderea ar fi zero (`ronor_knowledge` are 0 puncte), dar nu există
  mecanism. Redis nu are nici el copie (0 chei). Copia trebuie adăugată lângă
  `ronor-db-dump.sh` înainte ca memoria să primească date.
- **Un singur proiect compose** pentru cele patru containere nu există încă.
- Documentul e derivat din reconstrucția pe probă și din rețete. Nu a fost executat pentru a
  fi scris. Proba rămâne o nouă reconstrucție pe gazdă curată, numai din depozit și rețete.
