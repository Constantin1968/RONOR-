# RONOR — Raport de orientare

## Unde sunt, ce am, cum procedez

**Data:** 25 august 2026
**Perimetru:** planul de interfețe (App, Web, Consolă, Control, Bot), cele trei gazde RONOR, arhiva laptopului, arhiva Perplexity, cele cinci proiecte nominalizate, paritatea cu Grok Bot
**Metodă:** măsurare directă — apeluri HTTP publice, `ssh` prin Tailscale, citire de cod în clonă locală, inventar read-only al laptopului, surse primare deschise efectiv. Ce nu s-a putut verifica este declarat explicit.
**Regim:** niciun merge, push, release sau deploy. Nicio valoare de secret nu apare în acest document.

---

## 1. Sinteza executivă

Trei propoziții, dacă nu citiți nimic altceva.

**Unu.** Nu aveți un plan de interfețe — aveți patru suprafețe construite în repozitoriu (site public, consolă de operator, interfață de arhitect, bot Telegram) și **niciuna dintre ele nu este live pe nicio gazdă**; rădăcina publică a RONOR servește astăzi pagina de autentificare a Langfuse, iar singura interfață care răspunde efectiv este un tablou de bord React nescris în niciun repozitoriu, expus neautentificat.

**Doi.** Nu aveți o problemă de inteligență — aveți chei la șase furnizori de modele și rutare prin Portkey, deci „nivelul Grok" ca putere de raționament este deja cumpărat; delta reală față de reperul Grok Bot este aproape integral **inginerie de interfață**, iar Telegram a adăugat exact primitivele care lipseau (streaming nativ, buton de oprire, mesaje bogate, mesaje efemere).

**Trei.** Nu aveți o problemă de cod — Gen 2 din `src/runtime/` are 1.084 teste trecute, zero erori de compilare și un lanț de autoritate pe automatizare mai riguros decât cel documentat public de xAI; problema este că **ce e bun nu rulează, iar ce rulează nu e versionat**.

---

## 2. Unde sunt — trei generații RONOR care coexistă

| Generație | Ce este | Perioadă | Stare |
|---|---|---|---|
| **Gen 1** — Build Week TypeScript | `web/`, `src/model-exchange`, spină de guvernanță | 19–21 iulie | Îngheață. Simulează răspunsuri. |
| **Gen 1.5** — planurile Python „R-" | `/opt/ronor/*.py`, `/opt/ronor-planes`, r-comms, r-monitor, r-execute | 5–9 august | **LIVE, 11+ zile.** Nu e în niciun repozitoriu. |
| **Gen 2** — `src/runtime/` | 70 fișiere, 13.114 linii, mandat de arhitect semnat, evidence runner izolat | 3–24 august | **1.084/1.084 teste, 0 erori tsc. Nedesfășurat.** |

Aceasta este structura de fond a tuturor contradicțiilor pe care le vedeți. Gen 1.5 e ce ține lumina aprinsă; Gen 2 e ce ați construit ca să o înlocuiască; Gen 1 e ce vede publicul când există ceva de văzut.

### Gazdele

| Gazdă | Tailscale / public | Rol real | Stare măsurată |
|---|---|---|---|
| DigitalOcean `ronor-sovereign` | 100.124.123.90 / 165.245.248.223 | 14 containere, rulează `fix/release-readiness-conf5` @ `6a50a7e` | **Nu răspunde HTTP public.** Propriul tablou de bord raportează `do-frankfurt: down, planesHealthy 0/8`. |
| Hetzner `ronor-secondary` | 100.83.241.57 / 178.104.118.10 | 16 vCPU, 30 G RAM, 58 containere — gazda de facto | **Singura care servește web.** |
| Contabo | 100.87.14.42 / 169.58.129.223 | necunoscut | **Nu răspunde HTTP public. SSH refuză cheia** (`Permission denied (publickey,password)`). Tabloul de bord o raportează `provisioning`. |
| bastion | 100.77.197.28 | — | gol |

Două surse independente confirmă că DigitalOcean e căzută: sondarea externă și raportul propriului tablou de bord dinăuntrul tailnetului. Contabo rămâne o gazdă la care nu aveți acces demonstrat — este a treia dintre „cele trei RONOR" și, practic, nu o controlați.

---

## 3. Planul de interfețe — ce e declarat, ce e construit, ce e live

### 3.1. Constatarea de fond

**Nu există niciun document în repozitoriu care să declare un plan de interfețe.** Nici în `docs/`, nici în fișierele `*.md` din rădăcină. Termenii „RONOR App" și „RONOR Web" nu apar nicăieri în cod. Ce există sunt suprafețe de facto, apărute prin acumulare.

Singura doctrină de interfață pe care am găsit-o este una **istorică, în arhiva de conversații**, formulată pe 6 august: *„Command Center / ronor.tech ca suprafață principală, RONOR Telegram ca canal mobil"*, ambele împărtășind o singură bază de cunoaștere, plus decizia arhitecturală că tabloul de bord are **propriul backend** și e un „client frate" al orchestratorului. Pe 26 iulie fusese formulată și cerința de teren: *„interfață umană — pe telefon, când ești pe teren: vezi rezultate, aprobi decizii prin webhook, delegi misiuni noi prin chat"*.

Doctrina există. Nu a fost niciodată scrisă în repozitoriu. De aceea codul a evoluat fără ea.

### 3.2. Ce e construit în repozitoriu (@ `44f3798`)

| Suprafață | Fișiere | Linii | Declarată la | Titlu |
|---|---|---|---|---|
| Site public / Model Exchange | `web/index.html`, `app.js`, `styles.css` | 880 | `/` | „RONOR — Model Exchange & Governance Spine for Energy Operations" |
| **Consolă de operator** | `web/console/index.html`, `console.js`, `console.css` | **2.529** | `/console` | „RONOR — Operator Console" |
| Interfață de arhitect | `web/control/index.html`, `control.js`, `control.css` | 101 | `/control` | „CONTROL · RONOR" |
| **RONOR Bot (Telegram)** | `src/interfaces/telegram/` (7 fișiere) | **2.059** | Telegram | `@ronor_sovereign_bot` |
| Interfață Tailscale | `src/interfaces/tailscale/config.ts` | 81 | — | nu e o interfață de utilizator |

`src/index.ts` liniile 262–264 montează toate trei: `express.static('web/console')`, `express.static('web/control')`, `express.static('web')`.

**RONOR App nu există în nicio formă.** Zero `manifest.json`, zero service worker, zero meta `apple-mobile`. Nu e o aplicație amânată — nu a fost începută. Cerința de teren din 26 iulie a rămas neimplementată.

### 3.3. Ce e live — și de ce e mai grav decât „nimic"

Măsurat direct pe `http://178.104.118.10`:

| Rută | Rezultat | Ce servește efectiv |
|---|---|---|
| `/` | **200** | **Langfuse 4.4.0, pagină de autentificare.** Caddy `handle { reverse_proxy 127.0.0.1:3000 }` → containerul `langfuse-langfuse-web-1`. |
| `/api/public/health` | **200, neautentificat** | `{"status":"OK","version":"4.4.0"}` — versiune divulgată public |
| `/console` | **404** | nimic. Consola de 2.529 linii nu e servită nicăieri. |
| `/control/` | **401** | `python3 /opt/ronor/telemetry_aggregator.py` (port 8401) — **nu** interfața de arhitect din repozitoriu |
| `/dashboard/` | **200, neautentificat** | „RONOR Command Center" — `node server/index.js` din `/opt/ronor-cc` |
| `/dashboard/api/snapshot` | **200, neautentificat, 4.187 B** | censul complet al patrimoniului |

**Zero din patru suprafețe declarate în repozitoriu sunt live.** Aceasta este constatarea centrală a raportului.

### 3.4. Constatări noi de interfață (I-01 … I-12)

**I-01 — Rădăcina publică a RONOR servește Langfuse.** Regula de captare generală din Caddy trimite `/` către portul 3000, care nu e aplicația Express a repozitoriului, ci interfața web a platformei de observabilitate LLM. Consecință dublă: prima impresie publică a RONOR este ecranul de login al unui produs terț, iar depozitul complet de trasee — prompturi, completări, costuri — se află la o singură credențială de distanță de internetul deschis, cu versiunea divulgată neautentificat. **Critică.**

**I-02 — Consola de operator nu e desfășurată.** 2.529 linii, cea mai substanțială interfață construită, cu unsprezece apeluri către `/api/runtime` (`/agents`, `/agents/dispatch`, `/audit/verify`, `/catalogue`, `/health`, `/ledger/cost`, `/ledger/value`, `/ledger/work/`, `/providers`, `/query`, `/status`). Răspunde 404. **Ridicată.**

**I-03 — `/control` nu e interfața de arhitect.** Ruta publică `/control*` merge la portul 8401, care e un agregator de telemetrie Python — un artefact Gen 1.5, comentat în Caddyfile ca „dashboard suveran unificat (ARH, 09.08.2026)". Interfața de arhitect din repozitoriu, cu cabinetul nominalizat (Merlin aprobator, Richard mandat, Codex autoritate de verificare independentă, LangGraph planificator, OpenHands executant), nu răspunde la nicio adresă. **Ridicată.**

**I-04 — Tabloul de bord live nu e versionat și e deschis.** `/opt/ronor-cc` conține Vite + React + Tailwind + un backend propriu în `server/`, datat 5 august, **fără director `.git`**. Rulează ca proces `node` gol, pid 932, 11 zile fără întrerupere, fără supervizor. Serveșteneautentificat un cens complet: patru noduri, cincisprezece servicii cu latențe, corpusul CIDA (3.253 obiecte în lake, 28.733 documente, 25.520 duplicate, 15.433 entități, 39.046 mențiuni, 441 alerte deschise, 68.176 evenimente de audit), configurația de embedding și raționament, furnizorii, sarcinile programate și harta Tailscale. Aceeași clasă de defect ca C-05 și K-15. **Critică.**

**I-05 — Favorabil: firewall-ul e corect.** `ufw` e activ, implicit `deny (incoming)`, și permite public numai 22, 80, 443 și 41641/udp. Porturile 8401 și 8402 se leagă pe `0.0.0.0`, dar sunt permise doar din `172.20.0.0/16`. Legarea largă nu se traduce în expunere.

**I-06 — Tabloul de bord nu primește raport de la runtime.** Instantaneul propriu conține `ronor: status unknown, source unavailable`. Suprafața principală de comandă nu vede componenta pe care ar trebui să o comande.

**I-07 — Divergență între doctrină și cod.** `docs/control-executive-council.md` prescrie explicit că cheia de arhitect „must never be stored in Git, a URL, browser local storage, an email or mission state". `web/control/control.js` o păstrează în `sessionStorage['ronor.control.key']`. Litera diferă de `localStorage`; spiritul e încălcat. Separat, documentul descrie rutele `/api/runtime/management/*`, iar clientul apelează `/api/runtime/control/*` — două familii de rute coexistă în `routes.ts` (linia 609 și linia 833). **Medie.**

**I-08 — Favorabil, și important: autoritatea pe automatizare e corect construită în Gen 2.** Clientul din browser trimite `{approved: true}`, ceea ce pare o aprobare aserțiată de client. Nu este. Lanțul server-side, verificat în `src/runtime/api/routes.ts` liniile 623–700, impune: `requireArchitect` pe rolul cheii; respingere explicită cu `client_authority_fields_forbidden` dacă cererea conține `mandate`, `objective`, `issued_by` sau `allowed_actions`; mandat emis server-side și semnat cu o cheie de minimum 32 de octeți, altfel `mandate_authority_not_configured`; plafoane de cost, durată și cicluri de reparare; validare de workspace cu origine și HEAD așteptate și cerință de arbore curat; atestare obligatorie a unui evidence runner izolat, altfel `isolated_evidence_runner_attestation_failed`. `approved: true` e o declarație de intenție, nu o sursă de autoritate. **Acesta este cel mai bine construit strat din tot sistemul.**

**I-09 — Codul se avertizează singur.** `routes.ts` linia 234 emite `insecure-default-key: a shipped default API key is active — rotate RONOR_API_KEYS`. Cheile statice fără expirare din `RONOR_API_KEYS` sunt un defect pe care sistemul îl semnalează el însuși și nimeni nu l-a citit.

**I-10 — RONOR App nu există.** Nu e amânată; nu e începută.

**I-11 — Ultimul lucru pe interfețe s-a făcut pe 20–21 august.** Istoricul git pe `web/`: `25ea040` „add architect command interface", `11788ec` „route sovereign model cabinet", `47152de` „project observable automation runs" (20 aug), `f867db1` „enable direct governed automation", `842fbee` „detach governed runs from control requests", `c90fe4b` „expose safe automation recovery health" (21 aug). Din 22 august activitatea a fost integral pe automatizare, apoi integral pe documentare.

**I-12 — Copia de lucru de pe laptop e în urmă și pe o ramură de reparație.** `RONOR_CANONICAL` e pe `fix/evidence-runner-child-env` @ `bcd9f9f` (22 august 04:27), arbore curat, în urma lui `main` @ `44f3798` (24 august). Există 16 ramuri locale, dintre care șapte de tip `fix/openhands-*` și șase de tip `automation-*` / `control-*` / `governed-*` / `mission-state-*` — muncă terminată care nu a fost integrată.

---

## 4. RONOR Bot (Telegram) — starea reală

Botul există, tokenul e valid: id **8885653110**, `@ronor_sovereign_bot`, nume „RONOR". **Este mort pe ambele gazde din 10 august — cincisprezece zile.**

### Cum a murit

| Instanță | Imagine | Pornit | Oprit | Politică | Concluzie |
|---|---|---|---|---|---|
| DO `ronor-telegram` | `app-ronor:latest` | 8 aug 22:04:53Z | 8 aug 23:53:07Z | `unless-stopped`, RestartCount 0 | oprit deliberat |
| Hetzner `ronor-telegram-gov` | `app-ronor:sovereign` | 9 aug 00:42:46Z | 10 aug 01:19:33Z, SIGTERM, exit 0 | **`no`** | nu se mai întoarce singur |

### Anomalia nerezolvată

Jurnalele Hetzner sunt pline de `[409] Conflict: terminated by other getUpdates request` — dar aceste conflicte apar **după** ce DigitalOcean fusese deja oprită. O a treia instanță, neînregistrată nicăieri, a interogat același token pe 9–10 august. Contabo nu a putut fi verificată. Nu inventez o explicație: **există o instanță nelocalizată**, iar aceasta e prima poartă de trecut înainte de repornire.

### Ce am verificat pe server

Fără webhook. Zero actualizări în așteptare. **Zero comenzi înregistrate** la Telegram. `getUpdates` confirmă că nimeni nu interoghează. Niciun proces non-docker pe niciuna dintre gazde.

### Codul e bun

Opt comenzi (`start`, `help`, `status`, `query`, `mission`, `pending`, `approve`, `reject`). `approval-store.ts` implementează co-semnare Poarta 1 / Poarta 2 cu TTL de 60 de minute și — remarcabil — **nu stochează niciun token de ocolire**: la aprobare re-trimite payload-ul, astfel încât guvernanța rulează din nou. Ultimul commit pe folder, `d5054f1` din 19 august, „complete approved requests safely", a **îmbunătățit** botul nouă zile după ce murise.

### Contradicțiile care trebuie rezolvate înainte de repornire

1. **Containerele desfășurate nu sunt declarate în niciun fișier compose** de pe `/opt/ronor` sau `/opt/ronor-governance`. `docker-compose.production.yml` din repozitoriu le declară (liniile 219–252, `profiles: ["telegram"]`, limită 256 M, `restart: unless-stopped`) — dar nu e acesta cel care a fost folosit.
2. **`TELEGRAM_MODE=polling` apare de două ori**, în timp ce `TELEGRAM_WEBHOOK_URL` și `TELEGRAM_WEBHOOK_SECRET` sunt și ele setate. Configurația își contrazice propriul mod.
3. **Autoritatea de aprobare e un singur om.** `TELEGRAM_ALLOWED_USER_IDS` = `TELEGRAM_APPROVER_USER_IDS` = `TELEGRAM_CONTROL_CHAT_ID` = același identificator. Co-semnarea Poarta 1 / Poarta 2 are, în producție, un singur semnatar. Mecanismul e construit, separarea nu.
4. **Tokenul e partajat cu o componentă neguvernată care rulează.** `ronor-r-comms` (`ronor/r-comms:1.0.0`, sus 11 zile, sănătos, `127.0.0.1:8100`) deține același token și expune un `POST /telegram/send` fără guvernanță. Rezultat: **RONOR poate încă vorbi pe Telegram, dar nu poate asculta.** Canalul de aprobare e unidirecțional. Jurnalele r-comms arată corespondență externă reală — tichet DigitalOcean, modificări de plată, transfer de domeniu — deci componenta e activă, nu dormantă.
5. **Divergență de guvernanță între gazde.** Hetzner: QUALITY .25 / COST .25 / SOVEREIGNTY .25 / LATENCY .10 / RISK .10 / EVIDENCE .05 = 1,00. DigitalOcean: QUALITY .35 / COST .25 / LATENCY .20 / RISK .10 = 0,90, **fără SOVEREIGNTY, fără EVIDENCE**. Cele două gazde nu decid după aceeași constituție.

### Favorabil

Plafoanele PB-SEC-001 sunt configurate: cost maxim de misiune 2,00 USD, maximum 6 sarcini, timeout de agent 180 s, 2 MB limită de preluare, 3 încercări de rezervă, politica MI9 montată în container.

### Divulgare

Modelul meu de redactare a eșuat pe `RONOR_API_KEYS=` — șablonul a acoperit `KEY=`, nu `KEYS=`. Două chei statice în clar, cu etichetele `telegram-bridge:` și `console:`, fără expirare, au trecut prin contextul meu. **Nu le voi reproduce niciodată. Recomand rotația.** Șablonul corect este `[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*=`.

---

## 5. Ce am — inventarul arhivelor

### 5.1. Laptopul (DESKTOP-EAPCQUG, read-only, nimic instalat sau modificat)

Arhiva de lucru e concentrată aproape integral în `C:\Users\Hp\Downloads`: **26.990 fișiere, 9,15 GB**, cu doar patru intrări de nivel unu. Desktopul conține exclusiv scurtături. Rădăcina `C:\` nu are foldere de proiect.

| Zonă | Fișiere | Dimensiune |
|---|---|---|
| fișiere direct în `Downloads\` | 212 | 6.242,6 MB |
| `Telegram Desktop\` (export de chat) | 6.485 | 1.044,3 MB |
| `UploadFromMobile\` | 173 | 962,4 MB |
| `RONOR … Project Prioritization (1)\` | 20.120 | 478,6 MB |

**Două repozitorii git**, ambele detaliate la I-12 și mai jos: `RONOR_CANONICAL` (154 commit-uri, 16 ramuri locale, remote `Constantin1968/RONOR-`, arbore curat) și un nod experimental `Documents\Exercitii Laptop\RONOR` pe `mp003-neo4j`, un singur commit, fără remote, cu `docker-compose.yml` necomis.

**Redundanță de aproximativ 5,3 GB, în două grămezi curățabile:** patru arhive „Master Project RONOR" cvasi-identice de circa 694 MB fiecare (≈2,9 GB) și circa 2,4 GB de instalatori duplicați — ChatGPT 671 MB, Docker Desktop 643 MB, Google Drive 263 MB, VS Code 252 MB, Claude 236 MB, trei copii de Telegram.

**1.150 documente și arhive peste 100 KB**, grupate tematic: RONOR (instantanee, exporturi forensice, runtime versionat de la v0.3.0 la v0.10.0, rapoarte), CIDA, Mayleven, Continuumpedia și The Continuum Times, NrgPaths cu contracte și registre de dovezi, manuscrise — inclusiv `TheNewRenaissance-Session-Package.zip` de 99,3 MB.

**Unelte:** Node v24.18.0, npm 11.16.0, Git 2.55.0, launcher Python 3.14.6, OpenSSH 9.5.6.1, Tailscale 1.98.10. Docker Desktop și VS Code sunt instalate per-utilizator, deci versiunile nu au putut fi citite.

**Risc de securitate pe laptop, semnalat:** `github-recovery-codes.txt` (206 B) se află în clar în `Downloads`, alături de `env.automation.corrected` (9.325 B) și un `.env` cu parole de 8 și 13 caractere. Toate trei sunt lizibile de grupul `CodexSandboxUsers` cu `ReadAndExecute`. S-au raportat exclusiv numele variabilelor, lungimile valorilor și listele de control al accesului; **nicio valoare nu a fost citită**.

**Lacună importantă:** rădăcina profilului și `AppData` returnează „Access is denied" pentru contul punții. Existența `.ssh`, `.gitconfig`, `.claude`, `.codex` și a configurațiilor MCP **nu poate fi nici confirmată, nici infirmată**. Nu trag concluzii de acolo.

### 5.2. Arhiva Perplexity

**Brain:** 89 pagini de wiki — 59 de proiecte, 15 concepte, 15 entități — plus 14 preferințe durabile. **Sesiuni:** 25 indexate, 38 identificatori distincți pe disc, acoperind 24 mai – 25 august 2026. **Livrabile istorice:** 16 — trei de automatizare RONOR, șapte AIAgentics Evolution, cinci ecrane financiare valoare-momentum, un eseu.

**Cele cinci proiecte nominalizate:**

| Proiect | Sesiuni | Conținut |
|---|---|---|
| **NrgPaths OSaaS Deployer Co** | 2 | „Recuperarea Fișierelor Șterse" (17 aug) și sesiunea curentă |
| **Backup Manus Program** | 1 | manus.im / backup (21 aug) |
| **Hedge Funds Project** | 1 | administrator de fond pe Substack (21 aug), sursa nerecuperabilă atunci |
| **Global Tech Development Project** | 1 | aliniere tehnologico-financiară Brexit / Regatul Unit (15 aug) |
| **The New Renaissance Project** | 1 | canon plus audit RSIOR Master (25 aug), două versiuni de opt pagini |

**Constatare de sistem:** toate cele treisprezece proiecte Perplexity au **zero fișiere atașate și `knowledge_enabled=false`**. Nu există wiki-uri de proiect de citit. Contextul de proiect trăiește exclusiv în transcrierile de sesiune. Aceasta este o stare de configurare, nu o omisiune de lectură — și explică de ce reconstruiți contextul manual la fiecare sesiune.

### 5.3. Ce reiese din confruntarea celor trei arhive

Codul canonic e în trei locuri cu trei stări diferite: pe GitHub `main` @ `44f3798` (24 august), pe laptop pe o ramură de reparație @ `bcd9f9f` (22 august), și pe DigitalOcean o ramură veche @ `6a50a7e`, cu aproximativ 25 de commit-uri în urmă. Nicio gazdă nu rulează `main`.

---

## 6. Paritatea cu Grok Bot — evaluare onestă

### 6.1. Reperul, verificat la sursă

„Grok bot" acoperă trei produse diferite. Reperul relevant este **Grok Bot**, lansat pe 11 august 2026: colegi de echipă AI care rulează pe o **mașină virtuală Linux cloud persistentă** cu browser, sistem de fișiere și terminal, se autentifică în aplicații ca un om și revin doar când ceva are nevoie de aprobare ([x.ai](https://x.ai/news/introducing-grok-bot), [docs.x.ai](https://docs.x.ai/grok-bot/overview)). Mecanica de aprobare este Allow once / Deny / Always allow, cu un strat Auto Review bazat pe model, iar documentația spune franc că „o aprobare controlează acțiunea propusă; nu inversează munca deja finalizată" ([docs.x.ai](https://docs.x.ai/grok-bot/approvals-security-and-privacy)). Disponibilitate: beta, autentificare cu cont Cursor, macOS / Windows / iOS — **fără Linux desktop, fără Android**.

**Verificat contrar așteptării: xAI nu are bot oficial de Telegram.** Există `@GrokAI` cu circa 27 de mii de utilizatori, care se descrie ca „Grok 3", dar documentația xAI nu menționează Telegram nicăieri, iar acordul de 300 milioane USD din 2025 a fost contrazis public de Musk în aceeași zi — „no deal has been signed" ([CryptoSlate](https://cryptoslate.com/musk-says-no-deal-signed-with-telegram-despite-grok-integration-announcement/)). **Nu urmăriți un produs Telegram al xAI. Nu există.**

### 6.2. Ce se cumpără — deja cumpărat

`grok-4.6`: 500.000 tokeni de context, efort de raționament `low/medium/high/xhigh`, **2,00 USD input / 6,00 USD output** per milion de tokeni sub 200k ([docs.x.ai](https://docs.x.ai/developers/release-notes)). Aveți chei la șase furnizori și rutați prin Portkey. Claude Sonnet 5 la 2/10 USD, DeepSeek V4 Pro la 0,66 USD off-peak, Gemini 3.7 Flash la 0,75 USD. **„Inteligența la nivel Grok" este o linie de configurare, nu o etapă de dezvoltare.**

Un punct critic pentru arhitectură: documentația xAI spune explicit că „Grok nu are cunoștințe despre evenimente curente sau date dincolo de datele de antrenament" ([docs.x.ai](https://docs.x.ai/developers/models)). Senzația că „Grok știe ce se întâmplă acum" **nu e o proprietate a modelului** — e unealta `web_search`, facturată separat la 5 USD pe mia de apeluri.

### 6.3. Ce se construiește — și Telegram a rezolvat partea grea

Aceasta este descoperirea cu cel mai mare efect din întreaga cercetare. Telegram a adăugat primitive **native** pentru boți alimentați de modele de limbaj, iar hack-ul cu `editMessageText` nu mai e necesar ([Bot API 10.3, 24 august 2026](https://core.telegram.org/bots/api)):

- **`sendMessageDraft`** — transmite un mesaj parțial în timp ce e generat. Draft efemer, preview de 30 de secunde, doar în chat privat; modificările cu același `draft_id` sunt **animate**; **text gol afișează un placeholder „Thinking…" nativ**; `can_stop` afișează un **buton de oprire a generării**, iar botul primește actualizarea `stopped_message_generation`. Finalizarea se persistă cu un `sendMessage`.
- **`sendRichMessageDraft`** și blocul `RichBlockThinking` / `<tg-thinking>`.
- **Rich Messages** — tabele (inclusiv compacte), liste cu checkbox-uri, expresii matematice, `details` colapsabile, citate expandabile, footer, divider. Un output de guvernanță poate arăta ca un raport, nu ca un bloc de text.
- **Mesaje efemere** (Bot API 10.2) — promptul de co-semnare vizibil **doar co-semnatarului** într-un grup, fără a expune payload-ul întregului grup. Aceasta rezolvă direct problema de separare a autorității din §4.
- **Butoane `style: danger` / `success` / `primary`** și `DisabledButton` — aprobare roșie, respingere verde, buton dezactivat pentru TTL expirat.
- **Topics în chat-uri private** — separarea firelor de misiune într-un mesaj direct.
- **Comunicare bot-to-bot** — analogul Telegram al predării între boți.

Constrângerea reală de proiectare: **un mesaj pe secundă per chat**, 20 pe minut în grup, `callback_data` limitat la 64 de octeți — deci indexuri scurte către stare, nu payload-uri.

### 6.4. Unde RONOR poate **depăși** reperul

O recenzie independentă verificabilă față de documentație constată că Grok Bot **nu are încă un audit trail per-acțiune**, nu are sandbox (un „test run" execută muncă reală), și setul de documente nu conține nicio revendicare SOC 2, ISO 27001, GDPR sau HIPAA, nici perioadă de retenție, nici opțiune de rezidență ([eesel AI, 13 august 2026](https://www.eesel.ai/blog/grok-bot-review)).

RONOR are deja lanțul de mandat semnat, evidence runner izolat, atestare obligatorie și co-semnare cu TTL fără token de ocolire (I-08). **Pe guvernanță și dovadă, reperul e sub voi, nu peste voi.** Paritatea de urmărit este strict perceptuală: streaming, prezentare, memorie, buclă de unelte.

### 6.5. Ce nu se poate replica într-un bot de Telegram

Mașina virtuală cloud persistentă cu browser și terminal — esența Grok Bot, fără legătură cu Bot API. Preluarea controlului desktopului pentru parole, 2FA și CAPTCHA. Conversație vocală full-duplex. Streaming în grupuri (draft-urile cer chat privat). Descărcare de fișiere peste 20 MB, fără un Local Bot API Server propriu. **Transcrierea vocală — Bot API nu o oferă**, deci `getFile` → STT extern → model → TTS → `sendVoice`. Mai mult de o reacție per mesaj. Randare HTML arbitrară în afara unui Mini App.

---

## 7. Cum procedez — porți, nu termene

Ordinea e de dependență. O poartă nu se deschide înainte de cea precedentă, pentru că altfel construiți pe o premisă nedovedită.

### Poarta zero — opriți hemoragia de suprafață

Aceasta precede orice muncă de interfață, pentru că fiecare zi de întârziere e o zi de expunere.

1. Regula de captare generală din Caddy nu trebuie să servească Langfuse pe rădăcina publică (I-01). Langfuse merge sub o cale autentificată sau exclusiv pe tailnet.
2. `/dashboard/api/snapshot` nu trebuie să servească censul patrimoniului neautentificat (I-04).
3. Rotiți cheile din `RONOR_API_KEYS` — codul vă cere el însuși acest lucru (I-09), iar două dintre ele au trecut prin contextul meu.
4. Mutați `github-recovery-codes.txt` din `Downloads` — e lizibil de grupul de sandbox.
5. Rămân deschise C-01 (Whisper public neautentificat), C-02 (Postgres public), C-03 (ocolirea ufw de către Docker).

### Poarta unu — recâștigați cunoașterea a ce rulează

Nu se poate guverna ce nu e versionat. Trei artefacte care rulează în producție nu există în niciun repozitoriu: `/opt/ronor-cc` (tabloul de bord React, I-04), planurile Python Gen 1.5, și configurațiile desfășurate ale containerelor Telegram. Puneți-le sub git — nu ca refactorizare, ca înregistrare. Separat: obțineți acces la Contabo sau declarați-o pierdută; a treia gazdă nu poate rămâne o necunoscută.

### Poarta doi — decideți planul de interfețe și scrieți-l în repozitoriu

Doctrina din 6 august e sănătoasă și încă valabilă: **o suprafață principală de comandă, Telegram ca canal mobil de aprobare, o singură bază de cunoaștere.** Problema nu e doctrina, e că nu a fost scrisă. Decizia care trebuie luată explicit, pentru că blochează tot restul:

- Tabloul de bord React nescris devine suprafața principală și e adus în repozitoriu, **sau** consola de operator din repozitoriu (2.529 linii, deja construită, I-02) devine suprafața principală și tabloul de bord React e retras. Două suprafețe principale înseamnă zero.
- `/control` trebuie să servească interfața de arhitect din repozitoriu, nu agregatorul de telemetrie Python (I-03).
- Cheia de arhitect iese din `sessionStorage`, conform propriei doctrine (I-07).
- „RONOR App" se declară explicit: fie un Mini App Telegram (HTTPS, buton inline în chat privat), fie o aplicație web progresivă din suprafața principală, fie se elimină din vocabular. Astăzi e un cuvânt fără referent (I-10).

### Poarta trei — însănătoșirea botului, în ordine strictă

Nu reporniți înainte de a parcurge pașii unu și doi. Un al doilea conflict de `getUpdates` va costa mai mult decât așteptarea.

1. **Localizați sau excludeți a treia instanță.** Conflictele 409 din 9–10 august sunt inexplicate. Contabo e suspectul care nu a putut fi verificat.
2. **De-duplicați tokenul.** `ronor-r-comms` deține același token și expune un `POST /telegram/send` neguvernat. Fie token separat pentru r-comms, fie acceptați explicit credențiala partajată ca decizie de risc consemnată.
3. **Rezolvați contradicția de configurare** — `TELEGRAM_MODE=polling` de două ori, cu webhook setat simultan.
4. **Declarați containerul într-un fișier compose** și porniți-l cu o politică reală de repornire. `restart: no` explică de ce cincisprezece zile de moarte au trecut neobservate.
5. **Înregistrați cele opt comenzi la Telegram** — zero sunt înregistrate acum, deci botul e invizibil în interfață chiar și când rulează.
6. **Separați autoritatea de co-semnare.** Mecanismul Poarta 1 / Poarta 2 e construit; cu un singur identificator în toate cele trei variabile, nu semnifică nimic. Mesajele efemere din Bot API 10.2 fac separarea practicabilă într-un grup.
7. **Unificați ponderile de guvernanță** între gazde. DigitalOcean rulează fără SOVEREIGNTY și fără EVIDENCE, cu sumă 0,90.

### Poarta patru — paritatea perceptuală, în ordinea impact / efort

Numai după ce botul rulează guvernat. Cinci intervenții, de la cea mai profitabilă:

1. `sendMessageDraft` cu `draft_id` stabil, plus `sendMessage` final. Cea mai mare diferență percepută, cel mai mic efort.
2. Text gol în draft — placeholder „Thinking…" nativ, gratuit.
3. `can_stop=True` cu handler pe `stopped_message_generation`.
4. Butoane `danger` / `success` și `DisabledButton` la expirarea TTL, pe fluxul de aprobare existent.
5. Memorie de conversație per chat, separată în reguli durabile față de instrucțiuni de sarcină — modelul „description" versus „message" din Grok Bot.

Apoi: buclă de unelte către runtime-ul propriu (HTTP-ul există, bucla lipsește), Rich Messages pentru output de guvernanță, voce în ambele sensuri prin STT și TTS externe.

### Poarta cinci — desfășurați Gen 2

1.084 teste trecute, zero erori de compilare, cel mai riguros strat de autoritate din sistem (I-08) — și nedesfășurat. Rămâne C-09, `verified_confidence` null, singurul blocaj OSaaS. Șaisprezece ramuri locale conțin muncă terminată neintegrată (I-12). Merge-ul rămâne uman și cere acordul dumneavoastră, de fiecare dată.

### Poarta șase — CIDA și baza de cunoaștere unică

Porțile CIDA rămân cele stabilite: reducerea suprafeței publice, expirarea credențialelor, trasabilitate și git, egress default-deny, legarea dovezilor la evaluări, lanț de audit, primitive constituționale, aplicarea retenției. Nu promovați CIDA public înainte de Poarta zero.

### Trei interdicții care rămân valabile

Nu atingeți planurile Python care rulează. Nu rescrieți pentru eleganță. Nu promovați nimic public înainte de Poarta zero.

---

## 8. Ce nu am putut verifica

1. **Contabo** — SSH refuză cheia; HTTP nu răspunde. A treia gazdă rămâne necunoscută, inclusiv ca posibilă gazdă a instanței fantomă de Telegram.
2. **A treia instanță de bot** din 9–10 august — existența e dedusă din conflictele 409, localizarea nu.
3. **Rădăcina profilului laptopului și `AppData`** — „Access is denied". `.ssh`, `.gitconfig`, configurațiile MCP și istoricul agenților CLI nu pot fi nici confirmate, nici infirmate.
4. **Conținutul celor circa 130 de arhive** de pe laptop, inclusiv cele patru de 694 MB — nedeschise, conform regimului read-only. Clasificarea se bazează pe nume, dată și dimensiune; duplicarea aparentă nu a fost verificată prin hash.
5. **Porturile non-standard de pe gazde, testate din sandbox** — 8401, 8402 și HTTPS pe IP direct returnează eșec de conexiune, dar mediul meu de execuție filtrează porturi neobișnuite. Testul de control a arătat că sondarea TCP din sandbox raportează „deschis" chiar și pentru porturi inexistente, deci este nefiabilă și am ignorat-o. Concluzia de siguranță pe 8401/8402 se sprijină pe regulile `ufw` citite direct (I-05), nu pe sondare externă.
6. **Operatorul real al `@GrokAI`** pe Telegram și modelul pe care rulează.
7. **Prețurile de output** pentru modelele Grok altele decât `grok-4.6`, și orice cifră de viteză — xAI nu publică tokeni pe secundă sau time-to-first-token.
8. **Comportamentul Portkey** ca gateway pentru primitivele avansate xAI — Responses pe WebSocket, Context Compaction, `service_tier: priority`. Un gateway generic normalizează de obicei doar Chat Completions. Merită testat înainte de a arhitectura pe ele.
9. **Existența Grok 5** — nu apare în notele de lansare oficiale la 25 august 2026.

---

## 9. Sarcina programată

Supraveghetorul care monitorizează repozitoriul pentru cereri de integrare verzi dar neintegrate, verificări obligatorii picate și regresii de protecție a ramurii **a fost suspendat automat** după rulări ratate din cauza epuizării creditelor, la 11:31 și 15:05, plus o a treia la 15:43. Cauza e financiară, nu funcțională. Se reia automat când creditele revin. Nu l-am șters.

---

*Document pregătit pentru NrgPaths Smart Solutions Ltd. Toate cifrele de infrastructură provin din măsurare directă la 25 august 2026. Constatările de referință externă sunt legate de sursa primară deschisă efectiv.*
