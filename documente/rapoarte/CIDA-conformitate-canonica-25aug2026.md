# CIDA — Verificare de conformitate față de Canonul Constituțional

**Obiect:** stiva CIDA desfășurată (cida-api, cida-worker, cida-postgres, cida-minio, cidavault) și cele cinci domenii publice, evaluate față de articolele testabile ale canonului *The New Renaissance* / *Mayleven Canonical Architecture* / PB-SEC-001.
**Data:** 25 august 2026
**Gazdă:** Hetzner Nuremberg, `178.104.118.10` (AS24940), acces prin Tailscale `100.83.241.57`
**Metodă:** sondare read-only pe gazdă (trei scripturi, transfer verificat prin sha256) plus teste externe la nivel de protocol din afara estate-ului. Nicio scriere, niciun restart, niciun merge, niciun deploy.
**Sursa canonului:** documentele se află fizic în `/opt/cida-archive` — `NewRenaissance/TheNewRenaissanceExpandedCanonicalEditionv30.pdf`, `NewRenaissance/The_New_Renaissance_Master_Editorial_Blueprint_v2.3.pdf`, `Mayleven/Mayleven_Canonical_Architecture_RONOR_Continuumpedia_CIDA_Product.pdf`, `RONOR/RONOR_CANON_v1.md`, `CIDA/CIDA_Edition_14_Deep_Analysis.pdf`.

---

## 0. Notă de metodă — un test de control obligatoriu

Testul naiv de conectare TCP a raportat porturile 1, 7, 9999 și 61234 ca „deschise" pe `178.104.118.10`. Sunt porturi care nu pot fi deschise. Prin urmare **orice rezultat obținut prin conectare TCP este inutilizabil pe această rută** și a fost eliminat. Fiecare afirmație de expunere din acest raport provine dintr-un răspuns HTTP la nivel de protocol, cu cod de stare și corp verificate.

Aceeași disciplină se aplică lecției reținute din auditul RONOR: pe `cida.tech` orice cale returnează 200, deci o verificare de cod de stare singură ar fi „demonstrat" un API funcțional care nu există la acea adresă.

---

## 1. Verdict

Pe poarta de decizie a arhitecturii canonice — `APPROVE / HOLD / RETURN FOR REVISION` — CIDA, așa cum este desfășurat, este **RETURN FOR REVISION față de propriul canon**.

Motivul nu este ambiție neîmplinită. Este că **primitivele constituționale lipsesc din cod, nu doar din configurație**, într-un sistem care deja deține 28.720 documente, 15.432 entități, 470 entități de tip PERSON, 3.639 numere de telefon și material etichetat HUMINT și SIGINT.

Nouă concepte centrale ale canonului — `materiality`, `quarantine`, `provenance`, `custody`, `truth_state`, `contradiction`, `hash_chain`, `immutab*`, `residency` — **nu apar niciunde** în cele 7.649 linii de Python din `/opt/cida/app` și nici în cele 15 KB de `001_schema.sql`. Zero apariții, verificat prin grep recursiv.

Ce există este un pipeline OSINT/RAG competent și real. Ce nu există este stratul constituțional care ar face din el CIDA.

**Clauza de falsificare** a Blueprintului Editorial v2.3 obligă la slăbirea tezei dacă un sistem non-constituțional obține același rezultat la cost mai mic. Aplicată onest aici: în starea desfășurată, CIDA nu demonstrează nimic ce un pipeline de colectare și vectorizare obișnuit nu ar putea demonstra. Diferența constituțională este declarată în documente, nu implementată în runtime.

---

## 2. Ce funcționează — constatări favorabile

Acestea sunt reale și trebuie spuse înaintea criticii.

| # | Constatare | Dovadă |
|---|---|---|
| F-01 | **Stratul Lake există și e disciplinat.** 3.248 obiecte brute în MinIO, partiționate pe cele cinci discipline (`osint`, `finint`, `techint`, `humint`, `sigint`) | `docker exec cida-minio ls /data/cida-lake` |
| F-02 | **Fiecare obiect brut are amprentă.** `raw_documents.sha256` populat 3.248 / 3.248 | interogare `count(sha256)` |
| F-03 | **Lake-ul nu este ocolit.** Documente cu `raw_id IS NULL` = 0 din 28.720. Fiecare document derivă dintr-o capturare brută | interogare directă |
| F-04 | **Deduplicarea funcționează.** `simhash` populat 28.720 / 28.720; 25.511 duplicate marcate corect prin `dedup_of`; 3.209 unice | interogare directă |
| F-05 | **Legătura eveniment–document e completă.** 0 din 4.010 evenimente fără `document_id`; doar 7 din 4.512 relații fără `evidence` | interogare directă |
| F-06 | **Vocabularul disciplinelor e impus la nivel de schemă.** `CHECK (discipline IN ('OSINT','SIGINT','HUMINT','FININT','TECHINT'))` — singurul control de guvernanță real în bază | `pg_constraint` |
| F-07 | **Fiabilitatea surselor folosește scala Admiralty.** `sources.reliability` implicit `'C'` | schema |
| F-08 | **Cheile API sunt stocate hash-uite, cu scopuri și rate-limit.** `api_keys.key_hash`, `scopes`, `rate_limit` | schema |
| F-09 | **Endpointurile de date impun autentificarea.** `/documents`, `/stats`, `/audit`, `/keys` → 401 `missing or invalid API key` din exterior | test extern |
| F-10 | **Planurile de execuție sunt corect închise.** `POST /r-execute/execute/shell`, `/execute/docker`, `/execute/file`, `GET /r-execute/logs`, `GET /r-schedule/schedules` → toate 403 `Not authenticated` din exterior | test extern |
| F-11 | **Nicio expunere directă de port.** 8300, 5433, 9100, 9101, 3100, 6333, 8401, 8402 — toate filtrate la nivel de protocol din exterior | test extern |
| F-12 | **API și worker rulează ca utilizator neprivilegiat** `cida`, fără `privileged` | `docker inspect` |
| F-13 | **Consola MinIO e protejată** cu basic auth; Qdrant impune propria cheie | Caddyfile, test extern 401 |
| F-14 | **Sistemul e viu și productiv**, nu o demonstrație. 20 de zile de operare continuă, 16.085 verificări de monitorizare, ultima rulare de pipeline la câteva minute înaintea sondării | `/r-monitor/status`, `pipeline_runs` |

---

## 3. Constatări de neconformitate

Numerotate K-01…K-16. Numerotarea C-01…C-18 din raportul RONOR rămâne separată.

### 3.1 Critice

---

**K-01 — Disciplina stărilor de adevăr nu există; a fost înlocuită cu exact numărul unic pe care canonul îl interzice**

Canonul cere opt stări explicite — `Observed`, `Supported`, `Corroborated`, `Replicated`, `Contested`, `Superseded`, `Rejected`, `Unknown` — și interzice explicit reducerea la un singur procent de încredere.

Ce există în locul lor: o singură coloană `confidence numeric` pe **șase tabele** — `documents`, `entities`, `entity_mentions`, `relationships`, `events`, `assessments`, `briefs`. Nicio coloană de stare epistemică. Termenii `truth_state` și `contradiction` nu apar în cod.

Și numărul unic nici măcar nu este măsurat:

- **25.707 din 28.720 documente (89,5%) au `confidence` exact `0.45`** — o constantă atribuită la ingestie.
- Încrederile pe entități și relații sunt **literale scrise în cod**: `confidence=0.95` pentru ORG (`collection/finint.py:149`), `confidence=0.8` pentru PERSON (`collection/humint.py:172`), `confidence=0.7` pentru `MESSAGES_WITH` (`collection/sigint.py:316`), `confidence=0.6` (`collection/techint.py:195`).

Deci: singura cantitate epistemică din sistem este cea pe care canonul o interzice, iar ea este o constantă autorală, nu o estimare. Este aceeași clasă de defect ca `verified_confidence` scris null în RONOR — un slot de guvernanță fără măsurătoare în spate.

---

**K-02 — Fiecare evaluare din sistem este structural desprinsă de probe**

**2.472 din 2.472 de `assessments` au `document_ids` gol.** Fără excepție.

Sistemul produce judecăți cu `severity` și `confidence`, pe care le expune prin `/assessments`, `/briefs` și `/deepdive`, iar niciuna nu indică documentul din care provine. Canonul cere „grounded answers cu evidence packets" și „capital allocation governed by evidence". Aici lanțul probatoriu este rupt la ultimul pas, exact acolo unde produce output pentru decizie.

Contrastul este instructiv: la relații lanțul e aproape complet (7 din 4.512 fără probe), la evenimente e complet (0 din 4.010). Deci mecanismul de legare există în sistem. Nu este folosit acolo unde contează cel mai mult.

---

**K-03 — Nu există lanț criptografic de audit; iar câmpul de atribuire al auditului e controlat de apelant**

`cida.audit_log` are 68.105 rânduri acoperind 5–25 august. Coloanele sunt: `id`, `ts`, `api_key_id`, `label`, `ip`, `method`, `path`, `status`, `latency_ms`, `detail`. Este un jurnal de acces HTTP.

Nu există `prev_hash`, nu există lanț, nu există semnătură. Nu poate detecta ștergerea sau modificarea unei intrări. Canonul (cap. 36–42, „audit & cryptographic memory") cere lanț SHA-256 verificabil independent — lucru care **există în RONOR** (`tests/audit/hash-chain.test.ts`, `scripts/verify-chain.ts`) și lipsește complet din CIDA.

Agravant: containerul rulează `uvicorn --proxy-headers --forwarded-allow-ips *`. Cu asta, coloana `ip` înregistrează orice valoare `X-Forwarded-For` trimisă de apelant. Singurul câmp de atribuire al jurnalului este falsificabil de la distanță.

---

**K-04 — Egress default-deny nu se aplică deloc stivei CIDA**

PB-SEC-001 cere `default-deny network egress` cu allowlist. Test direct din interiorul containerelor:

```
cida-worker  -> https://api.github.com  HTTP 200
cida-api     -> https://api.github.com  HTTP 200
cida-minio   -> https://api.github.com  HTTP 200
```

Rețeaua lor, `ronor-expansion`, are `internal=false`.

Ceea ce face constatarea mai grea, nu mai ușoară: pe **aceeași gazdă** există `ronor-model-egress` cu `internal=true` și `ronor-automation-control` cu `internal=true`. Controlul este construit, înțeles și folosit în altă parte. CIDA pur și simplu nu a fost pus în spatele lui.

---

**K-05 — Catch-all-ul Caddy publică ~12 planuri interne pe internet, iar Cloudflare nu are nicio relevanță**

Caddy servește un bloc `:80` **fără restricție de Host**, deci accesibil pe IP-ul brut, cu douăsprezece rute `handle_path` și doar patru blocuri `basic_auth` în tot fișierul.

Deschise fără nicio autentificare, verificate din exterior:

| Rută | Ce returnează |
|---|---|
| `/cida/health` | recensământul complet al corpusului (vezi K-06) |
| `/cida/openapi.json` | 69,8 KB — întreaga suprafață API a sistemului |
| `/r-monitor/status` | harta serviciilor interne, cu nume de containere și URL-uri interne (`http://portkey-gateway:8787/`) |
| `/r-execute/openapi.json` | schema completă a `POST /execute/shell` |
| `/r-schedule/health` | `temporal_connected:true, worker_running:true, schedules:4` |
| `/gw/` | `AI Gateway says hey!` — Portkey răspunde neautentificat, cere doar un header de rutare |
| `/nemo/v1/chat/completions` | acceptă POST și răspunde `[RAILS_PASSED]` |
| `/langgraph/`, `/guardrails/`, `/lakera/` | se identifică și își enumeră endpointurile |

Cele cinci domenii sunt irelevante pentru această expunere. Ele rezolvă către Cloudflare (`104.21.*`, `172.67.*`) și servesc pagini statice de prezentare — `https://cida.tech/cida/health` returnează HTML-ul de marketing, nu API-ul. **Originea se atinge pe IP brut, unde nicio regulă Cloudflare nu se aplică.**

---

### 3.2 Grave

---

**K-06 — Recensământul complet al unui sistem de intelligence este public și neautentificat**

`http://178.104.118.10/cida/health` returnează, fără cheie:

- corpus: 28.720 documente (3.209 unice, 25.511 duplicate), 5.330 fragmente, 15.432 entități, 39.034 mențiuni, 4.512 relații, 4.010 evenimente, 2.472 evaluări, 24 briefuri, 440 alerte deschise, 36 surse active, 68.116 evenimente de audit;
- pe disciplină: OSINT 17.088, FININT 10.675, TECHINT 954, **HUMINT 2, SIGINT 1**;
- pe urgență: FLASH 982, IMMEDIATE 312, PRIORITY 1.449, ROUTINE 25.977;
- pe tip de entitate: AMOUNT 4.013, **PHONE 3.639**, IDENTIFIER 2.450, ORG 1.979, LOCATION 591, **PERSON 470**, ASSET 405, EMAIL 12;
- configurație: `bge-m3`, `deepseek-v4-pro`, colecția `cida_intel`, bucketul `cida-lake`, `llm_enabled`, `auto_analyze`.

Nu se scurge conținut. Se scurge **forma sistemului**: că există, ce colectează, pe ce discipline, cu ce modele, cât de mare e și cât de urgent lucrează. Pentru un sistem descris public drept „Encrypted, Secure, Access-Controlled", asta este exact informația care nu ar trebui să fie gratuită.

---

**K-07 — Harta către execuția de shell este publică, iar cheia care o deschide nu expiră niciodată**

Execuția e corect închisă (403). Dar `/r-execute/openapi.json` publică neautentificat existența și forma exactă a țintei: `POST /execute/shell`, corp `{command: string, timeout: int ≤ 300, working_dir: string|null}`, autentificare prin header `X-API-Key`.

În același timp, `cida.api_keys` conține **două** chei:

| id | etichetă | scopuri | activă | rate | apeluri | expiră |
|---|---|---|---|---|---|---|
| 1 | `root` | `{read, write, admin}` | da | 6000 | 6.135 | **NICIODATĂ** |
| 2 | `verification-readonly` | `{read}` | nu | 120 | 3 | niciodată |

PB-SEC-001 cere `short-lived mission tokens` și privilegiu minim. Modelul de acces real este o singură cheie permanentă cu toate scopurile. Combinația — hartă publică plus cheie fără expirare — transformă o singură scurgere de credențial în shell arbitrar pe gazdă.

---

**K-08 — Stratul Archive nu este un depozit validat; se autodeclară depozit brut**

Canonul definește CIDA.Archive drept „citable repository of validated artefacts", cu sensibilitate implicită LOCKDOWN.

Ce există: `/opt/cida-archive`, 29 MB, **31 de fișiere** (18 PDF, 10 DOCX, 2 MD, 1 MP4), în nouă foldere tematice, `root:root`, **fără git, fără nicio sumă de control, fără nicio semnătură** (căutare după `*sha256*`, `*.sig`, `*.asc`, `*hash*` → 0 rezultate).

`MANIFEST.md` declară el însuși:

> `## Status: DRAFT — Lake Layer Raw Deposit`

Deci Archive-ul recunoaște în propriul manifest că nu a fost niciodată promovat din Lake. Nu are identificatori de citare, nu are înregistrare de validare, nu are integritate.

Ironia care merită consemnată: **documentele canonului locuiesc aici** — `RONOR_CANON_v1.md`, `TheNewRenaissanceExpandedCanonicalEditionv30.pdf`, `Mayleven_Canonical_Architecture...pdf`, pachetul constituțional al Fundației Mayleven din Liechtenstein. Constituția este păstrată nehash-uită, negestionată, într-un folder al cărui manifest spune DRAFT.

---

**K-09 — Stratul Vault este o interfață, nu un motor de custodie**

Canonul cere ca Vault-ul să păstreze pachete semnate, autonome, cu doctrină, politică, baseline, SBOM și hash-uri.

Ce există: `/opt/cidavault`, 20 MB, 413 fișiere, `package.json` cu numele `cidavault` v1.0.0, **fără descriere**, 64 de dependențe npm dominate de `@radix-ui/*`, plus `@aws-sdk/client-s3` și `drizzle` (`db:push`). Servește o aplicație de 369 KB intitulată „CIDAVault — Intelligence Analysis & Secure Storage" pe `127.0.0.1:3100`.

Este o aplicație web React. Nu există pachete semnate, nu există custodie de doctrină, nu există SBOM, nu există registru de hash-uri. Numele stratului este ocupat de un front-end.

---

**K-10 — Continuumpedia nu există ca componentă de runtime**

Canonul îi atribuie: knowledge graph, evidence & confidence engine, contradiction engine, cross-domain linker, emergence engine, gap identifier, Delta Alerts, disciplina celor opt stări.

Verificat: **niciun container** cu `continuum` sau `pedia` în nume; `/opt/continuumpedia` inexistent; nicio unitate systemd; nicio bază de date în afară de `cida`; iar cererea către origine cu `Host: continuumpedia.com` cade în catch-all-ul Caddy pe o aplicație Next.js pe `:3000`, nu pe un serviciu Continuumpedia.

Graful de cunoaștere există parțial, ca `entities` + `relationships` + `entity_mentions` în Postgres. Motoarele de contradicție, emergență și identificare de lacune nu există în cod — `contradiction` are zero apariții.

Din cele șapte straturi canonice — Pool, Lake, Vault, Wiki, Command, Broker, Federation — starea reală este: **Lake real, Command parțial** (briefuri, evaluări, alerte), **Broker în afara CIDA** (Portkey), **Pool, Vault, Wiki și Federation absente sau doar nominale.**

---

**K-11 — Poarta de materialitate, carantina, proveniența și lanțul de custodie nu există**

Toate cele patru concepte au zero apariții în cod și schemă. Promovarea din Lake în corpus este un `processed boolean` pe `raw_documents`, comutat necondiționat.

Consecințe concrete:

- Nu există stare de **carantină**, deci nimic nu poate fi reținut în așteptarea verificării. Tot ce intră devine imediat document interogabil.
- Nu există **poartă de materialitate**, deci nu există decizie înregistrată despre ce merită păstrat. Ciclul canonic de incident (`eveniment extern → Materiality Gate → Lake → verificare și reconciliere → Archive → Continuumpedia → evaluare → Vault`) nu are implementare.
- **Proveniența** se reduce la `source_id` plus `sha256`. Nu există înregistrare despre cine a mutat ce, când și sub ce autoritate — adică nu există lanț de custodie.

---

**K-12 — Retenția este declarată și niciodată executată**

Patru politici, toate `enabled=true`:

| țintă | TTL | acțiune | ultima rulare | eliminate |
|---|---|---|---|---|
| `raw_documents` | 730 z | DELETE | **niciodată** | 0 |
| `audit_log` | 365 z | DELETE | **niciodată** | 0 |
| `alerts` | 180 z | DELETE | **niciodată** | 0 |
| `pipeline_runs` | 90 z | DELETE | **niciodată** | 0 |

Douăzeci de zile de operare, zero treceri de aplicare, zero obiecte eliminate. Există `POST /retention/enforce` — nu a fost chemat niciodată. Politica există ca rând în tabel, nu ca efect.

Rezidența nu apare niciunde: `residency` are zero apariții. Canonul o cere explicit ca dimensiune de control.

---

### 3.3 Medii

---

**K-13 — Ingestia nu este imutabilă; este durabilă prin convenție**

Bucketul MinIO `cida-lake` nu are configurație de versionare și nici de object-lock (`/data/.minio.sys/buckets/cida-lake/` fără intrări corespunzătoare). Canonul cere „immutable ingestion, quarantine". Obiectele brute pot fi suprascrise sau șterse de credențialul pe care API-ul îl deține deja. Amprentele SHA-256 permit **detectarea** unei modificări, dacă cineva le verifică — nu o **împiedică**, și nu există niciun verificator programat.

---

**K-14 — LOCKDOWN nu există; iar decizia de sensibilitate e delegată modelului, fără poartă umană**

Vocabularul de clasificare este, în `processing/classify.py:24`, exact `["UNCLASSIFIED", "CONFIDENTIAL", "SECRET"]`. Implicit: `UNCLASSIFIED` (`classify.py:105`). Canonul stabilește LOCKDOWN ca sensibilitate implicită pentru Archive și ca mecanism de suveranitate („LOCKDOWN rămâne local"). **Nu există.**

Distribuția reală: 26.575 UNCLASSIFIED, 2.140 CONFIDENTIAL, 5 SECRET. Deci mecanismul funcționează — dar plafonat la trei niveluri și fără cel care contează pentru suveranitate.

Mai important: decizia este luată de un LLM. `classify.py:71` începe `"You are the classification engine of CIDA, a professional intelligence..."`, iar `/health` confirmă `auto_analyze: true` și `llm_enabled: true`. Etichetarea sensibilității unui corpus care conține material HUMINT și SIGINT și 470 de entități-persoană se face automat, de un model, fără poartă umană și fără MI9 pe traseu. Canonul rezervă deciziile purtătoare de responsabilitate porților umane.

---

**K-15 — Trasabilitatea doctrină-către-cod este imposibilă**

- `/opt/cida` — **fără git** (`git: ABSENT`), fără remote.
- Imaginea `ronor/cida:1.0.0` — fără fișier `VERSION`, fără metadate git, singurele etichete fiind cele generate de docker-compose.
- `docker-compose.yml` are două copii `.bak-20260809_003610` și `.bak-20260809_003644` — configurația desfășurată a fost editată în loc, pe 9 august.

Nu se poate stabili ce revizie de doctrină implementează codul care rulează. Este exact defectul C-05 din auditul RONOR, în a doua stivă. Canonul cere „doctrine-to-code traceability" ca proprietate a CIDA.Tech; în forma desfășurată, întrebarea nu are răspuns verificabil.

---

**K-16 — Nu există drept de ieșire, override uman sau stare sigură în CIDA**

Capitolele 36–42 cer identitate, autoritate, delegare, override uman, stări sigure și drept de ieșire din runtime. PB-SEC-001 cere cale de kill independentă la nivel de rețea, proces, credențial și hardware.

În CIDA există un singur mecanism de retragere: `api_keys.enabled = false`. Nu există obiect de autoritate de execuție, nu există revocare cu condiții, nu există stare sigură definită, nu există cale de kill independentă. Iar MI9 și R-Sentinel — pe care arhitectura canonică le ține deliberat în afara runtime-ului pe care îl constrâng — **nu sunt pe traseul CIDA deloc**: ingestia, clasificarea și evaluarea rulează fără poartă de autorizare și fără supraveghere post-execuție.

---

## 4. Tabel de conformitate pe articol

| Articol canonic | Stare | Dovada scurtă |
|---|---|---|
| Lake — capturare brută, partiționată | **Conform** | 3.248 obiecte, 5 discipline, sha256 100% |
| Lake — imutabil | **Neconform** | fără versionare / object-lock (K-13) |
| Poartă de materialitate | **Absent** | zero apariții în cod (K-11) |
| Carantină | **Absent** | zero apariții în cod (K-11) |
| Proveniență / lanț de custodie | **Absent** | doar `source_id` + `sha256` (K-11) |
| Trust promotion | **Absent** | `processed boolean` necondiționat (K-11) |
| Rezidență | **Absent** | zero apariții (K-12) |
| Archive — depozit validat, citabil | **Neconform** | 31 fișiere, 0 hash-uri, manifest „DRAFT" (K-08) |
| Archive — implicit LOCKDOWN | **Absent** | vocabular fără LOCKDOWN (K-14) |
| Vault — pachete semnate, doctrină, SBOM | **Absent** | este o aplicație React (K-09) |
| Continuumpedia — cele opt stări | **Absent** | un singur `confidence` scalar (K-01) |
| Interdicția confidence-ului unic | **Încălcat direct** | 6 tabele × `confidence numeric` (K-01) |
| Contradiction engine | **Absent** | zero apariții (K-10) |
| Emergence engine / gap identifier | **Absent** | zero apariții (K-10) |
| Evidence packets pe output | **Neconform** | 2.472/2.472 evaluări fără probe (K-02) |
| Lanț de audit SHA-256 | **Absent** | jurnal HTTP fără `prev_hash` (K-03) |
| Atribuire de audit necoruptibilă | **Neconform** | `--forwarded-allow-ips *` (K-03) |
| Default-deny egress | **Încălcat direct** | HTTP 200 către internet din 3 containere (K-04) |
| Mission tokens de scurtă durată | **Neconform** | cheie `root` fără expirare (K-07) |
| Retenție guvernată | **Declarat, neexecutat** | 4 politici, 0 rulări (K-12) |
| Poartă MI9 / supraveghere R-Sentinel | **Absent pe traseul CIDA** | fără poartă la ingestie/clasificare (K-16) |
| Override uman / stare sigură / kill path | **Absent** | doar dezactivare de cheie (K-16) |
| Drept de ieșire | **Absent** | fără obiect de autoritate (K-16) |
| Trasabilitate doctrină-cod | **Imposibil** | fără git, fără VERSION (K-15) |
| Federation | **Absent** | fără componentă |
| Broker de modele | **În afara CIDA** | Portkey pe `:8787` |
| Discipline constrânse | **Conform** | CHECK la nivel de schemă (F-06) |
| Fiabilitate de sursă | **Conform parțial** | scala Admiralty, fără credibilitate separată |
| Autentificare pe date și execuție | **Conform** | 401 / 403 din exterior (F-09, F-10) |
| Fără expunere directă de port | **Conform** | toate porturile filtrate (F-11) |
| Suprafață publică minimă | **Neconform** | ~12 planuri pe catch-all `:80` (K-05) |

---

## 5. Cele cinci domenii — starea măsurată

Toate cinci — `cida.tech`, `cidaarchive.com`, `cidalake.com`, `cidavault.com`, `continuumpedia.com` — sunt pe Cloudflare cu **aceeași pereche de nameservere** (`aryanna` + `jasper`), deci același cont, cu Email Routing activ și SPF, HTTP 200, HSTS un an, `X-Frame-Options SAMEORIGIN`, `nosniff`, `referrer-policy`, `permissions-policy`. Fiecare servește o pagină de prezentare completă și îngrijită, în engleză, pentru stratul care îi corespunde.

Constatări măsurate:

- **Zero subdomenii operaționale.** `api`, `app`, `admin`, `login`, `dashboard`, `console`, `portal`, `auth`, `mail` — NXDOMAIN pe toate.
- **Niciun backend accesibil prin domeniu.** `/api/health` pe `cida.tech` returnează `content-type: text/html` — pagina de prezentare. `https://cida.tech/cida/health` returnează cele 27 KB de HTML de marketing, nu JSON-ul API-ului.
- **„Request Access" nu captează nimic.** Fără acțiune de formular, fără `mailto` în pagină.
- **`cidavault.com` are vhost real la origine, dar tăiat la nivel de DNS.** Caddyfile linia 13: `http://cidavault.com { reverse_proxy 127.0.0.1:3100 }`, iar originea servește corect aplicația de 369 KB. Însă DNS-ul public duce la Cloudflare, care servește pagina statică. **Singurul produs CIDA cu interfață funcțională este configurat pentru un domeniu care nu îl poate atinge.**

Risc narativ, în termenii doctrinei proprii: cinci domenii publice și indexabile declară custodie, criptare, control de acces și audit. Măsurat, în spatele lor: fără lanț de audit, fără carantină, fără lanț de custodie, fără LOCKDOWN, cu retenție neexecutată și cu recensământul corpusului public. Distanța dintre declarație și stare este ea însăși expunere.

---

## 6. Ordonarea remedierii — pe dependențe

Fără termene. Ordinea vine din ce blochează ce.

**Poarta A — reducerea suprafeței publice.** Restricționarea blocului `:80` la Host-uri cunoscute și închiderea rutelor neautentificate care nu trebuie publice: `/cida/openapi.json`, `/cida/health` (sau reducerea lui la `status` fără recensământ), `/r-*/openapi.json`, `/r-monitor/status`, `/gw/`, `/nemo/`, `/langgraph/`. Nu depinde de nimic, sunt modificări de configurație, și este singura poartă care reduce risc imediat.

**Poarta B — expirare și privilegiu minim pe credențiale.** Emiterea unei chei cu scop restrâns și termen pentru fiecare consumator real, retragerea cheii `root` permanente. Depinde de A doar în ordinea priorității, nu tehnic.

**Poarta C — recâștigarea trasabilității.** `/opt/cida` și `/opt/cidavault` sub git cu remote corect; o revizie identificabilă în imagine. Fără asta, orice remediere ulterioară nu poate fi verificată și niciun incident nu poate fi investigat. Este precondiția tehnică a tot restului.

**Poarta D — egress default-deny pe stiva CIDA.** Mutarea containerelor în spatele unei rețele `internal=true` cu uplink pe allowlist, folosind mecanismul care există deja pe gazdă.

**Poarta E — legarea probelor.** Popularea `document_ids` pe evaluări. Este un singur punct în cod și transformă 2.472 de judecăți nefundamentate în judecăți verificabile. Cea mai mare creștere de credibilitate pe cea mai mică modificare.

**Poarta F — lanț de audit.** Adăugarea `prev_hash` cu verificator independent, după modelul care există deja în RONOR, și eliminarea `--forwarded-allow-ips *`. Depinde de C, pentru că un lanț de audit pe cod netrasabil demonstrează integritatea unei necunoscute.

**Poarta G — primitivele constituționale.** Stări de adevăr în locul scalarului de încredere; stare de carantină; decizie de materialitate înregistrată; lanț de custodie; LOCKDOWN în vocabularul de clasificare; poartă umană pe clasificarea materialului HUMINT/SIGINT. Aceasta este cea mai mare parte de lucru și trebuie ultima, pentru că este singura care schimbă schema și modelul de date — și nu are sens să migrezi schema unui sistem a cărui revizie de cod nu o poți numi.

**Poarta H — aplicarea retenției.** Programarea `POST /retention/enforce`. Se face în siguranță abia după F, pentru că prima trecere va șterge date și, fără lanț de audit, ștergerea nu va fi demonstrabil legitimă.

**Împotriva a trei lucruri:** nu se promovează public niciunul din cele cinci domenii înaintea porții A; nu se leagă `cidavault.com` la origine înaintea porților A și B; nu se rescrie nimic pentru eleganță.

---

## 7. Limitele acestui raport

- Nu s-a citit conținutul niciunui document, entitate sau evaluare din corpus. S-au citit doar structura, numărătorile și distribuțiile.
- Nu s-au afișat valori de secrete. Hash-ul basic auth pentru consola MinIO a fost văzut în configurație și este exclus deliberat.
- Portkey pe `/gw/` răspunde neautentificat și cere doar un header de rutare. **Nu am testat dacă acceptă o cerere de inferență completă**, pentru a nu consuma credențiale ale unui furnizor extern. Rămâne neverificat și trebuie fie închis, fie testat deliberat.
- Nu s-a verificat conținutul colecției Qdrant `cida_intel` (5.330 puncte, 1024 dimensiuni, `bge-m3`) — accesul cere cheia proprie a Qdrant, iar sondarea a rămas read-only.
- Cele 7.649 linii de Python au fost analizate prin căutare țintită de termeni canonici și prin citirea punctelor unde se atribuie `confidence` și `classification`. Nu este o revizuire completă de cod.
- Nu s-a atins nimic: fără scriere, fără restart, fără merge, fără deploy.

---

*Raport întocmit de Perplexity Computer, 25 august 2026. Toate constatările provin din sondare read-only pe gazdă și din teste externe la nivel de protocol, executate în aceeași zi. Canonul de referință este cel din documentele aflate în `/opt/cida-archive`.*
