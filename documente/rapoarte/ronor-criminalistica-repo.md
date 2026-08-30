# RONOR — Criminalistică de repozitoriu

**Obiect:** clona locală `/home/user/workspace/ronor`
**HEAD la momentul analizei:** `44f379870be43b617c4838cba0f066c053ce2b1a` (detached at FETCH_HEAD), identic cu `origin/main`
**Ultimul commit:** `chore(automation): parameterize published host ports (#25)` — Merlin the Ancient Architect, 24 august 2026, 19:13:04 +0300 (`git log -1 --format='%H %ad %an'`)
**Data raportului:** 25 august 2026
**Regim de lucru:** exclusiv citire. Nu s-a executat niciun `push`, `merge`, `fetch`, `checkout` sau `reset`. `git status --short` a returnat ieșire vidă atât la începutul, cât și la sfârșitul investigației.

---

## 0. Răspunsul direct la întrebarea centrală

**Ce muncă există în repo care nu e în `main`?**

Din 24 de ramuri remote (excluzând `origin/HEAD` și `origin/main`), **22 sunt strămoși integrali ai `origin/main`** — verificat individual cu `git merge-base --is-ancestor <ramura> origin/main`. Două ramuri raportează commit-uri proprii care nu se află pe `main`:

| Ramură | Commit-uri în plus față de `origin/main` | Conținut încă absent din `main` |
|---|---|---|
| `origin/automation/parameterize-host-ports` | 1 (`6d23501`) | **Niciunul.** |
| `origin/chore/unpin-approved-sha` | 2 (`7dcd0b6`, `3b93eff`) | **Niciunul.** |

Ambele au fost integrate prin *squash merge* (PR #25 → `44f3798`, PR #24 → `fa0b246`), deci commit-urile originale rămân neatinse ca obiecte git, dar modificările lor sunt deja pe `main`. `git diff origin/main origin/chore/unpin-approved-sha` arată că ramura **elimină** parametrizarea porturilor de gazdă introdusă ulterior de PR #25 — adică ramura e mai veche decât `main`, nu mai avansată. Simetric, `git diff origin/main origin/automation/parameterize-host-ports` arată că ramura **reintroduce** SHA-ul hardcodat `0f80a60886abeca5f2205ed0fcef7ce908706933`, pe care PR #24 l-a scos intenționat din `main`.

**Concluzie: nu există muncă funcțională orfană în acest repozitoriu.** Cele două ramuri „neintegrate" sunt instantanee pre-merge stagnante, iar aplicarea lor peste `main` ar constitui o regresie, nu un câștig. Singura divergență reală de stare este că **ramura locală `main` (`264a55b`) e cu 2 commit-uri în urma lui `origin/main`** — `git rev-list --left-right --count main...origin/main` → `0	2`.

**Cine a scris ce?** Repozitoriul are 167 de commit-uri pe toate referințele, dintre care 164 accesibile din `origin/main`. Toate sunt semnate cu identități umane sau cu personaje operaționale ale unui singur om (Constantin Liviu NITA / „Merlin", plus persona „AMB"). Există **un singur trailer `Co-authored-by`** în tot istoricul, iar el numește o identitate de serviciu, nu un agent AI comercial. Contribuția de tip Codex este documentată exclusiv **în proză**, în fișiere de submisie — nu în metadatele git. Detalii în secțiunea 4.

---

## 1. Ramuri

### 1.1 Stare locală

`git branch -a` raportează trei referințe locale:

| Referință | Commit | Stare |
|---|---|---|
| `HEAD` | `44f3798` | detached at FETCH_HEAD, egal cu `origin/main` |
| `main` | `264a55b` | `[behind 2]` față de `origin/main` |
| `automation/parameterize-host-ports` | `6d23501` | copie locală a ramurii remote omonime |

`git worktree list` returnează un singur worktree: `/home/user/workspace/ronor 44f3798 (detached HEAD)`. Nu există worktree-uri secundare.

### 1.2 Toate ramurile remote, cu divergență față de `origin/main`

Coloanele „în urmă / în avans" provin din `git rev-list --left-right --count origin/main...<ramura>`: prima cifră = commit-uri pe care le are `origin/main` și ramura nu, a doua = commit-uri pe care le are ramura și `origin/main` nu.

| Ramură | Ultimul commit | Data | Autor | În urmă | În avans | Integrată în `main` |
|---|---|---|---|---|---|---|
| `origin/main` | `44f3798` | 2026-08-24 19:13 | Merlin the Ancient Architect | 0 | 0 | referință |
| `origin/automation/parameterize-host-ports` | `6d23501` | 2026-08-24 11:31 | RONOR Ops `<ops@ronor.local>` | 2 | **1** | **NU (ancestor=NO)** |
| `origin/chore/unpin-approved-sha` | `7dcd0b6` | 2026-08-23 23:26 | Merlin the Ancient Architect | 2 | **2** | **NU (ancestor=NO)** |
| `origin/fix/evidence-runner-test-db` | `7ebdd33` | 2026-08-22 01:32 | Constantine Liviu NITA | 11 | 0 | DA |
| `origin/fix/openhands-agent-settings` | `28a6c8a` | 2026-08-22 01:09 | Constantine Liviu NITA | 12 | 0 | DA |
| `origin/fix/openhands-health-schema` | `e90acd5` | 2026-08-22 00:47 | Constantine Liviu NITA | 13 | 0 | DA |
| `origin/fix/openhands-health-secret` | `580acc2` | 2026-08-22 00:37 | Constantine Liviu NITA | 14 | 0 | DA |
| `origin/fix/openhands-pyinstaller-runtime` | `17d538f` | 2026-08-22 00:28 | Constantine Liviu NITA | 15 | 0 | DA |
| `origin/fix/openhands-1.42-entrypoint` | `3531f86` | 2026-08-22 00:05 | Constantine Liviu NITA | 16 | 0 | DA |
| `origin/feature/automation-async-runs-v1` | `53064a5` | 2026-08-21 23:46 | Constantine Liviu NITA | 17 | 0 | DA |
| `origin/feature/automation-tailscale-gateway-v1` | `384db4b` | 2026-08-21 10:12 | Constantine Liviu NITA | 44 | 0 | DA |
| `origin/feature/automation-model-egress-v1` | `bdf4847` | 2026-08-21 09:53 | Constantine Liviu NITA | 46 | 0 | DA |
| `origin/feature/control-direct-automation-v1` | `4eed95a` | 2026-08-21 09:40 | Constantine Liviu NITA | 48 | 0 | DA |
| `origin/feature/automation-activation-v1` | `cd71a81` | 2026-08-21 08:58 | Constantine Liviu NITA | 51 | 0 | DA |
| `origin/feature/automation-run-lifecycle-v1` | `6e8c2ef` | 2026-08-21 07:57 | Constantine Liviu NITA | 56 | 0 | DA |
| `origin/feature/governed-execution-boundary-v1` | `9ebbf32` | 2026-08-21 07:31 | Constantine Liviu NITA | 58 | 0 | DA |
| `origin/feature/mission-state-fabric-v1` | `59ed704` | 2026-08-20 17:40 | Constantine Liviu NITA | 92 | 0 | DA |
| `origin/fix/release-readiness-conf5` | `6a50a7e` | 2026-08-19 19:55 | AMB `<amb@mayleven.com>` | 106 | 0 | DA |
| `origin/reconcile/v0.5.0-20260819` | `5c1b61d` | 2026-08-19 19:27 | AMB | 108 | 0 | DA |
| `origin/feature/sovereign-deployment` | `aa1d083` | 2026-08-03 13:38 | AMB | 121 | 0 | DA |
| `origin/build/runtime-active` | `a1b8762` | 2026-08-03 02:21 | AMB (Archeon Master the Best) `<office@mayleven.com>` | 125 | 0 | DA |
| `origin/mip-014/r-knowledge` | `f7ca4d7` | 2026-08-02 21:04 | AMB (Archeon Master the Best), COO | 141 | 0 | DA |
| `origin/mip-013/r-sentinel` | `88a8b73` | 2026-08-01 12:00 | Constantin Liviu NITA `<office@mayleven.com>` | 157 | 0 | DA |
| `origin/mip-012/engineering-templates-automation` | `583a93b` | 2026-08-01 08:39 | AMB `<constantine@mayleven.com>` | 159 | 0 | DA |
| `origin/alignment/ronor-v1` | `84cc637` | 2026-07-21 11:16 | Constantin Liviu NITA (Merlin) `<merlin@ma11ai.com>` | 161 | 0 | DA |
| `origin/build-week` | `84cc637` | 2026-07-21 11:16 | Constantin Liviu NITA (Merlin) | 161 | 0 | DA |

### 1.3 Analiza celor două ramuri marcate NEINTEGRATE

**`origin/automation/parameterize-host-ports` — commit `6d23501f7beb7f3dcb03f87fc22b4e735c0e869f`**
Autor: `RONOR Ops <ops@ronor.local>`, 24 august 2026 11:31:43 UTC. Mesaj: `chore(automation): parameterize published host ports`. `git log --stat` arată `.env.automation.template` (+14) și `docker-compose.automation.yml` (8 linii modificate), total 18 inserări / 4 ștergeri. Aceeași modificare este pe `main` la `44f3798` ca squash merge al PR #25. Diferența reziduală față de `main` (`git diff origin/main origin/automation/parameterize-host-ports`) e strict inversul PR #24: ramura repune `RONOR_AUTOMATION_EXPECTED_HEAD=0f80a608...` hardcodat în template și în antetul lui `scripts/automation-bootstrap.sh`.

**`origin/chore/unpin-approved-sha` — commit-urile `7dcd0b6` și `3b93eff`**
Ambele: Merlin the Ancient Architect, 23 august 2026 23:26 UTC. `7dcd0b6` atinge `scripts/automation-bootstrap.sh` (2 linii), `3b93eff` atinge `.env.automation.template` (8 inserări / 2 ștergeri). Aceeași modificare este pe `main` la `fa0b246` (PR #24). Diferența reziduală față de `main` e strict inversul PR #25: ramura scoate cele patru variabile `RONOR_AUTOMATION_*_HOST_PORT` și rehardcodează `127.0.0.1:2024`, `:3001`, `:3002`, `:3003` în `docker-compose.automation.yml`.

**Interpretare:** ambele ramuri sunt sigur ștergibile. Ele nu conțin muncă nesalvată; conțin doar amprenta pre-squash a unor PR-uri deja închise. Cele 22 de ramuri cu `ancestor=YES` sunt de asemenea candidate curate de ștergere — repo-ul păstrează 24 de ramuri de feature pentru un istoric de 164 de commit-uri.

---

## 2. Etichete

`git tag -l` returnează patru etichete. Tipul obiectului provine din `git cat-file -t`, ancestralitatea din `git merge-base --is-ancestor <sha> origin/main`.

| Etichetă | Tip obiect | Commit | Data commit-ului | Autor | Subiect | Strămoș al `origin/main` |
|---|---|---|---|---|---|---|
| `pre-alignment-main-e9de519` | commit (lightweight) | `e9de5194c1643345cdd6c7eecfef5caef713d02d` | 2026-07-19 17:21 | Constantin1968 | RONOR v1.0 — Sovereign Generative Intelligence Runtime | DA |
| `v2.1.0-baseline` | tag adnotat | `03f4a17c0e561df78f8956b081e26dd3e354068f` | 2026-08-01 14:01 | Merlin the Ancient Architect | MIP-012: Engineering Templates & Automation (#2) | DA |
| `v0.4.0-core-active` | tag adnotat | `57f437937bc5849539054865db0370d4376148d9` | 2026-08-03 01:00 | AMB | ci(release): add fetch-depth: 0 to checkout step | DA |
| `v0.5.0-20260819` | tag adnotat | `792b5a6de8e9697513e2bdf632ceb6eecedc11e8` | 2026-08-19 23:03 | Merlin the Ancient Architect | Merge pull request #7 from Constantin1968/fix/release-readiness-conf5 | DA |

Toate cele patru etichete sunt strămoși ai `origin/main`. Nicio etichetă nu indică o linie de dezvoltare abandonată.

### 2.1 Incoerențe de versionare

- **Numerotarea scade în timp.** `v2.1.0-baseline` (1 august) este urmată cronologic de `v0.4.0-core-active` (3 august) și `v0.5.0-20260819` (19 august). Ordinea semantică a versiunilor contrazice ordinea temporală. `RELEASE_MANIFEST.md` (liniile 19–25) documentează explicit această alegere: „The version string is deliberately expressed as `0.4.0-core-active` rather than a continuation of the `2.x` build-week numbering." Decizia e documentată, dar nu e reflectată nicăieni în tooling — orice consumator care sortează semver va citi `v2.1.0-baseline` drept cea mai recentă.
- **`package.json` nu corespunde niciunei etichete.** Câmpul `version` este `2.0.0-build-week`, adică rămas în seria abandonată. Nu există etichetă `v2.0.0-build-week`, iar `RELEASE_MANIFEST.md` declară versiunea curentă `0.4.0-core-active`. `scripts/generate-checksums.sh` (linia 8) citește versiunea din `package.json` prin `node -p "require('./package.json').version"`, deci artefactele de release generate local se vor numi `2.0.0-build-week` indiferent de eticheta reală.
- **`RELEASE_MANIFEST.md` fixează un commit de release inexistent în seria actuală.** Câmpul „Release commit" este `bbed8343c4341541e747942bf69c155818cbf258`, în timp ce eticheta `v0.4.0-core-active` indică `57f4379`.
- **`CHANGELOG.md` declară istoricul închis.** Secțiunea `[Unreleased]` afirmă „No changes are pending. The R-Knowledge integration described under `0.4.0-core-active` closed the last open engineering item on `main`." Ultima modificare a fișierului e din 3 august 2026, dar `main` a primit ulterior aproximativ 60 de commit-uri (întregul program de automatizare, PR #7–#25). Nu există nicio intrare de changelog pentru `v0.5.0-20260819` sau pentru munca de automatizare din 19–24 august.
- **Nicio etichetă nu marchează starea curentă.** Cel mai recent commit etichetat e din 19 august; `main` a avansat cu 6 zile și mai multe PR-uri fără etichetă. `.github/workflows/release.yml` se declanșează exclusiv pe `push` de etichete `v*`, deci verificarea de release nu a rulat pe starea curentă.

---

## 3. Stash-uri, worktree-uri, obiecte orfane, fișiere netracked

| Verificare | Comandă | Rezultat |
|---|---|---|
| Stash-uri | `git stash list` | ieșire vidă — niciun stash |
| Worktree-uri | `git worktree list` | unul singur: `/home/user/workspace/ronor 44f3798 (detached HEAD)` |
| Obiecte pierdute | `git fsck --lost-found` | ieșire vidă — nicio problemă |
| Obiecte inaccesibile / atârnate | `git fsck --unreachable --dangling` | ieșire vidă — **niciun commit orfan** |
| Reflog | `git reflog \| wc -l` | 5 intrări — clonă recentă, fără istoric local de operațiuni |
| Fișiere netracked | `git status --porcelain --untracked-files=all` | ieșire vidă |

**Fișiere ignorate prezente pe disc** (`git status --porcelain --ignored`):

- `node_modules/` — dependențe instalate; explică cele 16.762 de fișiere din arbore față de 343 urmărite de git (`git ls-files | wc -l`).
- `data/audit.db` — bază SQLite a lanțului de audit, generată la rulare. Ignorată corect prin regula `data/` din `.gitignore`. Prezența ei indică faptul că runtime-ul a fost pornit cel puțin o dată în acest director.

`.gitignore` conține o secțiune neobișnuit de explicită pentru artefactele R-Knowledge (`knowledge.db`, `knowledge.db-wal`, `knowledge.db-shm`, `knowledge-quarantine.jsonl`), cu justificarea în comentariu: „an ignore rule that depends on a directory being used is weaker than one that names the artefact". Niciunul dintre aceste artefacte nu e prezent pe disc.

Ansamblul e curat: nu există nici o urmă de muncă neangajată, ascunsă în stash sau desprinsă din graf.

---

## 4. Atribuire pe agent AI

### 4.1 Distribuția autorilor pe toate referințele

`git log --all --format='%an <%ae>' | sort | uniq -c | sort -rn` — 167 de commit-uri, 10 identități distincte de autor:

| Commit-uri | Autor | Email |
|---|---|---|
| 88 | Constantine Liviu NITA | `liviu.c.nita@gmail.com` |
| 27 | Merlin the Ancient Architect | `liviu.c.nita@gmail.com` |
| 21 | AMB (Archeon Master the Best), COO | `amb@mayleven.com` |
| 16 | AMB | `amb@mayleven.com` |
| 7 | AMB (Archeon Master the Best) | `office@mayleven.com` |
| 3 | AMB | `constantine@mayleven.com` |
| 2 | Constantin Liviu NITA (Merlin) | `merlin@ma11ai.com` |
| 1 | RONOR Ops | `ops@ronor.local` |
| 1 | Constantin1968 | `liviu.c.nita@gmail.com` |
| 1 | Constantin Liviu NITA | `office@mayleven.com` |

Grupate pe persoană reală: **117 commit-uri** aparțin lui Constantin Liviu NITA sub patru nume de afișare („Constantine Liviu NITA", „Merlin the Ancient Architect", „Constantin Liviu NITA (Merlin)", „Constantin1968", „Constantin Liviu NITA") și trei adrese; **47 de commit-uri** aparțin personei „AMB (Archeon Master the Best)" sub trei nume și trei adrese; **1 commit** identității de serviciu „RONOR Ops".

Lista committerilor (`--format='%cn <%ce>'`) adaugă doar `GitHub <noreply@github.com>` cu 24 de commit-uri — merge-urile efectuate prin interfața web GitHub.

### 4.2 Trailere de co-autor

Scanarea cerută — `git log --all --format='%H|%an|%ae|%s|%b' | grep -icE 'codex|manus|co-authored|generated with|claude|gpt|assistant|agent'` — returnează **22 de linii** care se potrivesc. Analizate una cu una, ele se împart astfel:

- **1 trailer `Co-authored-by` propriu-zis**, în corpul commit-ului `44f3798` (`chore(automation): parameterize published host ports (#25)`, Merlin the Ancient Architect, 24 august 2026): `Co-authored-by: RONOR Ops <ops@ronor.local>`. Este singurul trailer de co-autor din întreg istoricul, confirmat prin `git log --all --grep='Co-authored-by' -i`, care returnează exclusiv acest commit. Co-autorul numit este identitatea de serviciu locală care a scris și `6d23501` pe ramura de feature, nu un agent AI comercial identificabil.
- **Zero trailere `Generated with`, `Co-Authored-By: Claude`, `Co-Authored-By: Codex`** sau echivalente.
- **1 linie de atribuire în proză** într-un corp de commit: `Attribution: OpenAI GPT-5.6 (BESS proposer) · OpenAI Codex (scaffolding).`
- **Restul potrivirilor (20) sunt fals-pozitive semantice**: termeni de domeniu, nu semnături. Cuvântul „agent" apare în subiecte precum `fix(automation): harden agent service boundary`, `feat(automation): isolate agent authority stack`, `feat(runtime/L0,L2,L3,L7): ... multi-agent runtime`. „Codex" apare ca **nume de componentă software** — verificatorul independent al pipeline-ului de automatizare — în subiecte precum `feat(assurance): bind Codex verdicts to signed evidence`, `feat(automation): bind Codex verifier through Responses API`, `feat(automation): verify artifact integrity before Codex`. „GPT" și „claude" apar în corpuri care descriu adaptoare de provider (`GPT needs max_completion_tokens, Claude and Gemini need max_tokens`).

**Constatarea metodologică esențială: în acest repozitoriu, „Codex" desemnează în majoritatea aparițiilor un serviciu al arhitecturii, nu autorul unui commit.** Un grep naiv pe cuvântul „codex" supraestimează masiv atribuirea AI.

### 4.3 Atribuire în fișiere

`grep -rniE 'codex|manus' --include='*.md' --include='*.json' --include='*.yml' --include='*.yaml' --include='*.txt'` (exclus `node_modules` și `package-lock.json`) produce peste 80 de potriviri. Clasificate:

**(a) Atribuire declarată explicit de autor uman — ce a scris Codex**

- `DEVPOST_SUBMISSION.md:53` — cea mai precisă declarație de atribuire din repo: „**Codex** wrote the first version of the orchestration pipeline, the router scoring implementation, the audit-chain append and verify path, and most of the operator UI. I reviewed, tested, and edited every generated file before it was committed. Nothing was accepted blindly."
- `README.md:8` — „**Attribution:** OpenAI GPT-5.6 (BESS decision-loop proposer) · OpenAI Codex (orchestration scaffolding)"
- `VIDEO_SCRIPT.md:5` — „OpenAI GPT-5.6 (BESS decision-loop proposer) · OpenAI Codex (backend + orchestration scaffolding)"
- `YOUTUBE_LISTING.md:39` — „• Codex — orchestrator, router scoring, audit chain, UI scaffolding"
- `DEVPOST_SUBMISSION.md:101` — „Built with **OpenAI GPT-5.6** ... and **OpenAI Codex** (orchestration and adapter scaffolding)"
- `docs/reference/model-exchange-v0.1-original/DEVPOST_SUBMISSION.md:22` — pentru prototipul v0.1: „Codex was used to generate and refine the backend orchestration logic and dashboard components."
- `docs/reference/model-exchange-v0.1-original/HACKATHON_GUIDE.md:9–16` — procedură de generare a unui Codex Session ID ca dovadă de utilizare, cu referire la `codex/CODEX_INSTRUCTIONS.txt` (fișier prezent în arborele de referință).

Prin corelare cu inventarul de cod, zona revendicată pentru Codex acoperă: `src/orchestrator.ts` (156 linii), `src/model-exchange/` (6 fișiere, 1.406 linii), `src/runtime/router/scoring.ts`, `src/audit/hash-chain.ts` (345 linii) și `web/` (9 fișiere front-end). Este vorba de nucleul epocii hackathon (19–21 iulie 2026), nu de programul de automatizare din august.

**(b) Codex ca nume de serviciu în arhitectură — nu atribuire**

- `docker-compose.automation.yml` — serviciul `codex-verifier` (linia 142), comanda sa (`verification-authorities-server.js codex`), portul 3002, și șase secrete dedicate: `codex_verifier_token`, `codex_api_key`, `codex_receipt_private_key`, plus variabile de tarifare `RONOR_CODEX_INPUT_USD_PER_MTOK` / `RONOR_CODEX_OUTPUT_USD_PER_MTOK`.
- `docs/executive-automation.md` — peste 30 de apariții descriind rolul de autoritate de verificare independentă: „a Codex PASS is never converted" în verdict de asigurare (linia 46), „Codex signs every verification verdict with a short-lived Ed25519 receipt" (linia 233), „Only Codex receives `codex_receipt_private_key`; Victoria receives the matching `assurance_receipt_public_key`, so Victoria can verify but cannot forge a Codex" receipt (liniile 237–238).
- `docs/mission-state-fabric.md:47` — `codex` este unul din tipurile de actor admise în modelul de stare, alături de `human`, `ronor`, `langgraph`, `openhands`.
- `src/runtime/automation/services/codex-evaluator.ts` (57 linii) și `verification-authorities.ts` (102 linii) — implementarea.

**(c) Manus — doar două apariții, ambele semnificative**

- `AMB_BUILD_NOTES.md:14` — `OPENAI_API_BASE=https://api.manus.im/api/llm-proxy/v1` cu descrierea „OpenAI-compatible multi-vendor gateway". Aceasta este singura dovadă operațională că infrastructura Manus a fost efectiv folosită: ca gateway de modele în timpul construcției etichetate „AMB", 3 august 2026.
- `docs/executive-automation.md:329–330` — „**Manus remains deferred until after 26 August 2026; no Manus credential or execution path is enabled.**" O interdicție explicită, cu dată, scrisă la 21 august 2026.

**Nu există niciun commit, fișier de cod sau trailer care să atribuie muncă lui Manus.** Manus apare o dată ca proxy de rețea folosit și o dată ca dependență amânată prin politică.

### 4.4 Sinteză a atribuirii

| Sursă | Dovadă | Ce acoperă |
|---|---|---|
| **Om (Constantin Liviu NITA)** | 117 commit-uri sub 5 nume de afișare | întreg repozitoriul; toate merge-urile PR; toate briefurile QMa11 (iulie); tot programul de automatizare din august |
| **Persona „AMB"** | 47 commit-uri, 3 adrese `@mayleven.com` | MIP-012 / MIP-013 / MIP-014; `deploy/` (1.414 linii); dosarul `evidence/knowledge/`; `scripts/generate-sbom.py`, `verify-live.py`, `probe-providers.ts` (fiecare marcat „Prepared by AMB") |
| **„RONOR Ops" (identitate de serviciu)** | 1 commit autor + 1 trailer `Co-authored-by` | parametrizarea porturilor de gazdă în kitul de automatizare |
| **OpenAI Codex** | atribuire în proză în 6 documente; **zero trailere git** | orchestrator, scoring de router, lanțul de audit append/verify, majoritatea UI-ului de operator, din epoca hackathon |
| **OpenAI GPT-5.6** | atribuire în proză în 4 documente; zero trailere git | propunătorul buclei de decizie BESS |
| **Manus** | un endpoint de gateway în note de build; o interdicție datată | niciun cod atribuit |

**Limita probatorie:** atribuirea către Codex și GPT-5.6 nu este verificabilă din istoricul git. Ea se sprijină în întregime pe declarația scrisă a autorului uman în `DEVPOST_SUBMISSION.md`. Repozitoriul nu conține niciun ID de sesiune Codex — `DEVPOST_SUBMISSION.md:97` conține încă placeholder-ul „[session ID from `/feedback` — added at submission]", iar `docs/reference/model-exchange-v0.1-original/DEVPOST_SUBMISSION.md:37` conține „[ADD URL]". Dovada de utilizare cerută de regulamentul hackathon-ului nu a fost niciodată completată în repo.

---

## 5. Inventar complet al documentelor

47 de fișiere `.md` urmărite de git, în afara `node_modules`. Numărul de linii din `wc -l`, data și autorul din `git log -1 --format='%ad|%an' --date=short -- <fișier>`. Prag de stagnare: neatins de la **11 august 2026** sau mai devreme (peste 2 săptămâni înainte de 25 august 2026).

### 5.1 Arhitectură

| Fișier | Linii | Ultima atingere | Autor | Scop | Stagnant |
|---|---|---|---|---|---|
| `docs/executive-automation.md` | 440 | 2026-08-21 | Constantine Liviu NITA | Contractul complet al Executive Mission Runner v1: mandate, autorități de verificare, izolare de egress, chitanțe Ed25519 | nu |
| `docs/mission-state-fabric.md` | 75 | 2026-08-20 | Constantine Liviu NITA | Contract vendor-neutral de stare persistentă între agenți; tipuri de actor admise | nu |
| `docs/control-executive-council.md` | 74 | 2026-08-20 | Constantine Liviu NITA | Model de identitate CONTROL; separă rolul constituțional `architect` de `admin` | nu |
| `README.md` | 290 | 2026-08-02 | AMB (Archeon Master the Best), COO | Prezentare generală a runtime-ului guvernat; punct de intrare al repo-ului | **DA** |
| `docs/ronor-architecture-reconciliation.md` | 92 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Reconciliere între implementarea Build Week și straturile 0–7 din briefingul strategic | **DA** |
| `docs/reference/model-exchange-v0.1-original/ARCHITECTURE_ROADMAP.md` | 39 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Continuitate arhitecturală de la prototipul v0.1 | **DA** |

### 5.2 Planificare și strategie

| Fișier | Linii | Ultima atingere | Autor | Scop | Stagnant |
|---|---|---|---|---|---|
| `docs/roadmap-post-hackathon.md` | 113 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Foaie de drum după Build Week, ancorată la straturile 0–7 | **DA** |
| `docs/qma11-strategic-brief-18jul2026.md` | 549 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Briefing strategic Ma11AI/RONOR pe agentic-AI — cel mai lung document din repo | **DA** |
| `docs/qma11-robotics-brief-18jul2026.md` | 416 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Briefing de informații pe robotică | **DA** |
| `docs/qma11-platform-brief-18jul2026.md` | 299 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Briefing zilnic de informații de platformă | **DA** |
| `docs/qma11-science-brief-6jul2026.md` | 93 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Material de referință științific pentru narativul submisiei | **DA** |
| `docs/qma11-science-brief-9jul2026.md` | 83 | 2026-07-20 | Constantin Liviu NITA (Merlin) | idem, 9 iulie | **DA** |
| `docs/qma11-science-brief-7jul2026.md` | 80 | 2026-07-20 | Constantin Liviu NITA (Merlin) | idem, 7 iulie | **DA** |
| `docs/qma11-science-brief-10jul2026-addendum.md` | 66 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Addendum la briefingul din 10 iulie | **DA** |
| `docs/qma11-science-brief-8jul2026.md` | 61 | 2026-07-20 | Constantin Liviu NITA (Merlin) | idem, 8 iulie | **DA** |

Cele nouă briefuri QMa11 totalizează 1.647 de linii de material de referință extern, toate comise într-o singură zi (20 iulie 2026) și neatinse de atunci. Ele nu sunt documentație de proiect; sunt anexe de narativ pentru submisia hackathon.

### 5.3 Activare, operare, guvernanță de proces

| Fișier | Linii | Ultima atingere | Autor | Scop | Stagnant |
|---|---|---|---|---|---|
| `docs/BRANCH_PROTECTION.md` | 44 | 2026-08-01 | AMB | Setări recomandate de protecție a ramurii `main`, de aplicat manual în GitHub | **DA** |
| `docs/RELEASE_CHECKLIST.md` | 36 | 2026-08-01 | AMB | Listă de verificare pre/post-release | **DA** |
| `docs/TECHNICAL_REVIEW_TEMPLATE.md` | 62 | 2026-08-01 | AMB | Șablon de recenzie tehnică (TR-XXX) | **DA** |
| `.github/ISSUE_TEMPLATE/step0_assessment.md` | 78 | 2026-08-01 | AMB | Șablon de evaluare de impact STEP 0, obligatorie înainte de implementare | **DA** |
| `.github/ISSUE_TEMPLATE/engineering_directive.md` | 55 | 2026-08-01 | AMB | Șablon de directivă formală de inginerie | **DA** |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 43 | 2026-08-01 | AMB | Raportare de defect de runtime | **DA** |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 40 | 2026-08-01 | AMB | Propunere de capabilitate | **DA** |
| `.github/PULL_REQUEST_TEMPLATE.md` | 39 | 2026-08-01 | AMB | Șablon de PR cu referință la MIP | **DA** |

### 5.4 Note de build, release, submisie

| Fișier | Linii | Ultima atingere | Autor | Scop | Stagnant |
|---|---|---|---|---|---|
| `AMB_BUILD_NOTES.md` | 222 | 2026-08-03 | AMB (Archeon Master the Best) | Fișier de lucru intern pentru `build/runtime-active`; conține endpoint-ul gateway Manus | **DA** |
| `RELEASE_MANIFEST.md` | 187 | 2026-08-03 | AMB | Identitatea release-ului `0.4.0-core-active` și justificarea renumerotării | **DA** |
| `CHANGELOG.md` | 159 | 2026-08-03 | AMB | Changelog Keep-a-Changelog; ultima intrare `0.4.0-core-active` | **DA** |
| `docs/qwen-benchmark-2026-08-20.md` | 30 | 2026-08-20 | Constantine Liviu NITA | Benchmark controlat de routare Qwen prin Ollama, cu declarație de non-exfiltrare | nu |
| `docs/reconciliation/2026-08-19.md` | 79 | 2026-08-19 | AMB | Proces-verbal de reconciliere pentru `reconcile/v0.5.0-20260819` | **DA** |
| `BUILD_REPORT.md` | 66 | 2026-08-03 | AMB | Raport de build pentru „v0.5.0 Sovereign Deployment" | **DA** |
| `DEVPOST_SUBMISSION.md` | 103 | 2026-07-21 | Constantin Liviu NITA (Merlin) | Submisia Devpost; **sursa canonică de atribuire AI** | **DA** |
| `VIDEO_SCRIPT.md` | 107 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Script demo de 2:57 cu specificații tehnice video | **DA** |
| `YOUTUBE_LISTING.md` | 78 | 2026-07-21 | Constantin Liviu NITA (Merlin) | Titlu, descriere, taguri și capitole pentru listarea YouTube | **DA** |

**Notă de coerență:** `BUILD_REPORT.md` se autointitulează „RONOR v0.5.0 — Sovereign Deployment Build Report", datat 3 august, în timp ce eticheta `v0.5.0-20260819` a fost creată abia pe 19 august, iar `RELEASE_MANIFEST.md` din aceeași zi (3 august) documentează `0.4.0-core-active`. Trei documente scrise în aceeași zi de același autor folosesc două numere de versiune diferite.

### 5.5 Dovezi (`evidence/knowledge/`)

Toate cele 21 de artefacte au fost comise pe 2 august 2026 de „AMB (Archeon Master the Best), COO" — **toate stagnante**, ceea ce este așteptat pentru un dosar de dovezi imuabil, dar înseamnă că el atestă o stare a codului de acum trei săptămâni.

| Fișier | Linii | Scop |
|---|---|---|
| `STEP2_FINAL_REPORT.md` | 443 | Raport final MIP-014 STEP 2 privind implementarea planului R-Knowledge |
| `MIP014_STEP2_CANONICAL_DELIVERY_ATTESTATION.md` | 321 | Atestare canonică de livrare pentru instrumentul MIP-014-EO-STEP2 Rev 2 |
| `qdrant-adapter-report.md` | 212 | Raport de verificare a adaptorului Qdrant (poarta G6) |
| `qdrant-dependency-assessment.md` | 157 | Evaluare de dependență Qdrant, cerută de dosarul pre-implementare § 9b |
| `rollback-report.md` | 142 | Raport de exercițiu de revenire (poarta G8) |
| `benchmark-report.md` | 140 | Raport de benchmark de regăsire (poarta G7) |
| `G5-equivalence-attestation.md` | 115 | Atestare pentru poarta G5 (ABSOLUTĂ, nerenunțabilă) — echivalență în mod dezactivat |
| `security-review.md` | 105 | Recenzie de securitate și dependențe (limbul de securitate al porții G8) |
| `sbom.json` | 2.236 | SBOM CycloneDX al stării de la 2 august |
| `benchmark-report.json` | 452 | Varianta citibilă de mașină a raportului de benchmark |
| `conformance-report.json` | 197 | Raport de conformitate R-Knowledge |
| `equivalence-report.json` | 158 | Verdict de echivalență citibil de mașină |
| `mocked-transport-attestation.txt` | 142 | Atestare că transportul Qdrant a fost simulat, nu live |
| `branch-attestation.txt` | 121 | Atestare de identitate a ramurii |
| `file-manifest.txt` | 52 | Manifest de fișiere al livrării |
| `routes-disabled.txt` / `routes-enabled.txt` | 9 / 9 | Liste de rute în cele două moduri |
| `health-disabled.json` / `health-enabled.json` | 0 / 0 (o linie fără terminator) | Instantanee de răspuns `/health` în cele două moduri |
| `fs-diff-disabled.txt` | 0 | **Complet gol** (`find evidence -size 0 -type f`) — vidul este, prin construcție, dovada că nu s-a scris nimic pe disc în mod dezactivat, dar un artefact de zero octeți este indistinct de o captură eșuată |

### 5.6 Documente de referință arhivate (`docs/reference/model-exchange-v0.1-original/`)

Copie completă a prototipului v0.1 de Build Week, 25 de fișiere urmărite (7 `.md`, `.jsx`-uri de client React, `.js`-uri de server, `test_e2e.py`, `codex/CODEX_INSTRUCTIONS.txt`). Toate ultima atingere 20 iulie 2026 — **stagnante prin definiție**, fiind o arhivă. Cele 7 documente: `README.md` (56), `HACKATHON_GUIDE.md` (98), `ARCHITECTURE_ROADMAP.md` (39), `DEVPOST_SUBMISSION.md` (37), `RELEASE_STATUS.md` (31), `VIDEO_SCRIPT.md` (22).

**Bilanț:** din 47 de documente `.md`, **43 sunt stagnante** conform pragului de 2 săptămâni. Numai 4 au fost atinse după 11 august: `docs/executive-automation.md`, `docs/mission-state-fabric.md`, `docs/control-executive-council.md`, `docs/qwen-benchmark-2026-08-20.md` — toate scrise de Constantine Liviu NITA în intervalul 20–21 august, toate legate de programul de automatizare. **Documentația arhitecturală de nivel înalt (`README.md`) și cea de release (`CHANGELOG.md`, `RELEASE_MANIFEST.md`) nu au fost actualizate pentru niciunul dintre cele ~60 de commit-uri de automatizare care le-au urmat.**

---

## 6. Cod orfan și duplicat

### 6.1 Linii pe director de nivel 2 din `src/`

143 de fișiere `.ts` în `src/`, **32.051 de linii** în total (`find src -name '*.ts' | wc -l`, apoi `-exec cat {} + | wc -l`). Numărătoarea de mai jos este pe directorul propriu-zis, fără subdirectoare (`-maxdepth 1`).

| Director | Fișiere | Linii |
|---|---|---|
| `src/runtime/api` | 8 | 3.057 |
| `src/knowledge` | 11 | 2.832 |
| `src/runtime/providers` | 13 | 2.279 |
| `src/runtime/agents` | 5 | 2.218 |
| `src/interfaces/telegram` | 7 | 2.059 |
| `src/knowledge/stores` | 5 | 2.010 |
| `src/runtime/automation` | 18 | 1.476 |
| `src/planes/r-knowledge` | 3 | 1.436 |
| `src/runtime/router` | 6 | 1.435 |
| `src/model-exchange` | 6 | 1.406 |
| `src/knowledge/embedding` | 4 | 1.161 |
| `src/governance` | 2 | 1.016 |
| `src/persistence` | 3 | 978 |
| `src/decision-loop` | 3 | 924 |
| `src/sentinel` | 4 | 798 |
| `src/runtime/ledgers` | 3 | 750 |
| `src/api` | 5 | 734 |
| `src/sentinel/collectors` | 3 | 582 |
| `src/planes/r-sentinel` | 2 | 485 |
| `src/runtime/mission` | 1 | 491 |
| `src/audit` | 1 | 345 |
| `src/planes/r-model-fabric` | 1 | 338 |
| `src/runtime/knowledge` | 1 | 333 |
| `src/scripts` | 2 | 274 |
| `src/types` | 1 | 233 |
| `src/planes/r-context` | 1 | 214 |
| `src/runtime/management` | 2 | 158 |
| `src/planes/r-assurance` | 1 | 135 |
| `src/planes/r-gateway` | 1 | 112 |
| `src/planes/r-agent-runtime` | 1 | 102 |
| `src/planes/r-economics` | 1 | 102 |
| `src/interfaces/tailscale` | 1 | 81 |
| `src/planes/r-execution` | 1 | 64 |
| `src/utils` | 1 | 28 |
| `src/` (rădăcină: `index.ts` 332, `orchestrator.ts` 156) | 2 | 488 |

Pentru comparație: `tests/` numără 57 de fișiere și 14.349 de linii — un raport test/sursă de 0,45.

### 6.2 Module fără nicio referință de import

Metodă: pentru fiecare din cele 143 de fișiere `.ts` urmărite din `src/`, s-a căutat numele modulului în clauze `from '...'` și `require('...')` pe tot `src/`, `tests/` și `scripts/`, excluzând fișierul însuși. Pentru fișierele `index.ts` s-a căutat numele directorului părinte. Rezultat: 10 fișiere fără nicio referință de import. Clasificate corect:

**Puncte de intrare legitime — nereferite prin design, invocate prin `package.json` sau `docker-compose`:**

| Fișier | Linii | Invocat prin |
|---|---|---|
| `src/index.ts` | 332 | `package.json` → `main: dist/index.js`, `start`, `dev`. Rădăcina de compoziție. |
| `src/runtime/automation/services/openhands-bridge-server.ts` | 37 | `npm run automation:openhands-bridge` |
| `src/runtime/automation/services/verification-authorities-server.ts` | 24 | `npm run automation:codex-verifier` / `automation:assurance`; comanda serviciului `codex-verifier` din `docker-compose.automation.yml:144` |
| `src/runtime/automation/services/evidence-runner-server.ts` | 19 | `npm run automation:evidence-runner` |
| `src/runtime/automation/services/model-egress-proxy-server.ts` | 15 | serviciul `model-egress-proxy` din compose |
| `src/interfaces/telegram/index.ts` | 74 | comentariu propriu (liniile 8, 70): destinat `node dist/interfaces/telegram/index.js` sau apel din `src/index.ts` |

Excepție de semnalat: `src/interfaces/telegram/index.ts` declară în comentariu că `startTelegramBridge()` e „useful for single-host" invocare din `src/index.ts`, dar `grep -n "startTelegramBridge" src/index.ts` nu găsește nimic. Puntea Telegram (2.059 linii în `src/interfaces/telegram/`, plus 81 în `src/interfaces/tailscale/`) nu este montată de rădăcina de compoziție și nu are un serviciu propriu în niciunul din cele cinci fișiere `docker-compose*.yml`. Are totuși teste (`tests/interfaces/telegram-bot.test.ts`, `tests/interfaces/control-ui.test.ts`).

**Cod cu adevărat orfan — fără import, fără punct de intrare, fără test:**

| Fișier | Linii | Ultima atingere | Constatare |
|---|---|---|---|
| `src/model-exchange/engines.ts` | 329 | 2026-08-03 | `grep -rn "model-exchange/engines\|engines'" src tests scripts` → zero rezultate. Corespondent istoric: `docs/reference/model-exchange-v0.1-original/server/engines.js`. Rămășiță a prototipului v0.1. |
| `src/persistence/memory-manager.ts` | 222 | 2026-08-03 | `grep -rn "memory-manager\|MemoryManager" src tests scripts` → doar auto-referințe interne (liniile 23, 54, 217, 219, 220). Exportă un singleton `getMemoryManager()` pe care nimeni nu îl apelează. |
| `src/scripts/provision-qdrant.ts` | 158 | 2026-08-03 | duplicat divergent — vezi 6.4 |
| `src/scripts/provision-supabase.ts` | 116 | 2026-08-03 | duplicat divergent — vezi 6.4 |

Total cod orfan confirmat: **825 de linii**, plus 2.140 de linii de punte Telegram/Tailscale nemontată.

### 6.3 Duplicate de orchestrator, router și gateway

**Trei orchestratoare** (`git ls-files | grep -iE 'orchestrator'`):

| Fișier | Linii | Stare |
|---|---|---|
| `src/orchestrator.ts` | 156 | activ — importat de `src/index.ts:48` ca `RONOROrchestrator` și consumat de `src/api/router.ts:9` |
| `src/decision-loop/orchestrator.ts` | 351 | activ |
| `src/model-exchange/orchestrator.ts` | 384 | activ, dar aparține subsistemului `model-exchange` a cărui componentă `engines.ts` e orfană |

891 de linii sub trei fișiere cu același nume de bază, în trei subsisteme.

**Două straturi de routare paralele.** `src/index.ts` montează șase routere pe două prefixe distincte (liniile 246–256):
- `/api/runtime` ← `createRuntimeRouter` din `src/runtime/api/routes.ts` (**1.220 de linii într-un singur fișier**)
- `/api/v1` ← `createRouter` din `src/api/router.ts` (81) + `createDecisionsRouter` (227) + `modelExchangeRouter` (111) + `createSentinelRouter` (141), plus condițional `/api/v1/knowledge` ← `createKnowledgeRouter` (174)

Total 2.073 de linii de definiție de rute, împărțite între o suprafață `/api/v1` modulară (734 de linii pe 5 fișiere) și un monolit `/api/runtime` (1.220 de linii). Există în plus un director `src/runtime/router/` cu 6 fișiere / 1.435 de linii, care nu e un router HTTP ci motorul de selecție de model — coliziune de nomenclatură între „router" ca strat HTTP și „router" ca selector de model, în același arbore.

Un al treilea router istoric, `src/model-exchange/router.ts` (119 linii), coexistă cu `src/runtime/router/exchange.ts` și cu arhiva `docs/reference/model-exchange-v0.1-original/server/router.js`.

**Două gateway-uri** (`git ls-files | grep -iE 'gateway'`): `src/planes/r-gateway/index.ts` (112 linii, plan de guvernanță) și `src/runtime/providers/gateway.ts` (adaptor de provider). Nume identic, funcții disjuncte.

**Două work-ledgers:** `src/model-exchange/work-ledger.ts` (238 linii) și `src/runtime/ledgers/work-ledger.ts` (279 linii) — 517 linii pentru același concept contabil, în două subsisteme.

**Coliziuni de nume de bază în `src/`** (`git ls-files 'src/*' | xargs -n1 basename | sort | uniq -c`): `index.ts` ×12, `types.ts` ×4, `registry.ts` ×4, `policy.ts` ×3, `orchestrator.ts` ×3, `config.ts` ×3, `work-ledger.ts` ×2, `schema.ts` ×2, `router.ts` ×2.

### 6.4 Duplicare directă de fișier: scripturile de provizionare

`scripts/provision-qdrant.ts` și `src/scripts/provision-qdrant.ts` (ambele 158 de linii) sunt copii **divergente**, nu identice. `diff` arată două diferențe:

1. calea de import — `'../src/utils/logger'` vs `'../utils/logger'`;
2. **API-ul clientului Qdrant diferă**: varianta din `scripts/` folosește `client.api('cluster').clusterStatus()` și loghează `info.data?.status`; varianta din `src/scripts/` folosește `client.versionInfo()` și loghează `info?.version`.

`scripts/provision-supabase.ts` și `src/scripts/provision-supabase.ts` (ambele 116 linii) diferă doar prin calea de import a loggerului.

Nicio variantă nu e referită de `package.json`. Nu se poate stabili din repo care dintre cele două implementări de verificare Qdrant este cea corectă pentru `@qdrant/js-client-rest@1.18.0`.

---

## 7. Configurația CI

`.github/workflows/` conține două fișiere (`ls -la .github/workflows/`).

### 7.1 `ci.yml` — „CI — Build, Test & Security", 183 de linii

Declanșare: `push` pe `main` și `pull_request` către `main`. Concurență: grup `ci-${{ github.ref }}` cu `cancel-in-progress: true`. Șase job-uri:

| Job | Ce verifică | Dependență | Timeout |
|---|---|---|---|
| `build` — TypeScript Build | `npm ci`, `npm run build`, apoi verifică existența directorului `dist/` și eșuează dacă lipsește | — | 10 min |
| `test` — Jest Tests | `npm ci`, `npm test` (`jest --runInBand`), cu `fetch-depth: 0` | `needs: build` | 10 min |
| `security` — Security Scan | `npm audit --audit-level=critical`, apoi TruffleHog `--only-verified --fail` pe istoricul git | — | 10 min |
| `automation-preflight` — Automation Activation Preflight Contract | `bash -n scripts/automation-preflight.sh` pentru sintaxă; apoi rulează scriptul într-un mediu golit (`env -i`) și pretinde trei condiții: cod de ieșire nenul, zero linii `PASS network` sau `PREFLIGHT PASS` în ieșire, exact o instrucțiune `set RONOR_AUTOMATION_SECRET_DIR` | — | 5 min |
| `baseline-equivalence` — Baseline Equivalence (R-Knowledge disabled) | `npx jest tests/knowledge/equivalence.test.ts` cu `KNOWLEDGE_ENABLED` **deliberat nesetat** (absența e condiția de test); apoi `npm run build` + `bash scripts/knowledge-equivalence.sh` cu `OPENAI_API_KEY: placeholder`; apoi `npx jest --testPathIgnorePatterns="tests/knowledge"`; încarcă `evidence/knowledge/` ca artefact | `needs: build` | 10 min |
| `knowledge-conformance` — R-Knowledge Conformance | `npx jest tests/knowledge`; `npx ts-node scripts/benchmark-retrieval.ts` (codul de ieșire guvernat doar de poarta de release: acuratețe de citare și completitudine de proveniență); `npx ts-node scripts/verify-knowledge-conformance.ts`; încarcă `evidence/knowledge/` | `needs: build` | 15 min |

Comentariul de la liniile 89–96 documentează că job-urile `baseline-equivalence` și `knowledge-conformance` au fost **adăugate, nu modificate**, iar cele trei job-uri preexistente sunt „byte-identical to baseline d058544d in name, trigger, steps and semantics", tocmai pentru ca o eșuare în cele noi să nu poată fi confundată cu o regresie.

### 7.2 `release.yml` — „Release Verification", 38 de linii

Declanșare exclusiv pe `push` de etichetă `v*`. Un singur job (`verify-release`, 15 min): `npm ci`, `npm run build`, `npm test`, apoi împachetează `dist/`, `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml`, `src/governance/policies.yaml` și `web/` într-un `.tar.gz`, generează `SHA256SUMS.txt` și încarcă artefactul.

### 7.3 Workflow-uri dezactivate sau efectiv neaplicabile

**Niciun workflow nu are `if: false`, nu e redenumit în `.disabled` și niciun job nu e comentat integral.** Există însă trei slăbiri de facto:

1. **Scanarea de secrete nu poate eșua.** Pasul „Secrets scan" din job-ul `security` are `continue-on-error: true` (linia 71). TruffleHog rulează cu `--fail`, dar rezultatul lui nu poate opri pipeline-ul. Singura poartă de securitate care blochează efectiv este `npm audit --audit-level=critical`.
2. **`release.yml` nu s-a putut declanșa pe starea curentă.** Ultima etichetă `v*` este `v0.5.0-20260819`, deci verificarea de release nu a atins niciunul dintre commit-urile de pe `main` din 20–24 august, inclusiv întreg kitul de activare a automatizării.
3. **Pipeline-ul nu validează arhitectura declarată.** `jest.config.js` are `testMatch: ['**/tests/**/*.test.ts']` fără `testPathIgnorePatterns`, deci toate cele 57 de suite rulează — dar nu există niciun job de lint în CI, deși `package.json` definește `npm run lint` (`eslint src --ext .ts`) și `npm run typecheck` / `npm run build:check` (`tsc --noEmit`). `npm run build` compilează, deci erorile de tip sunt prinse indirect, dar regulile ESLint din `eslint.config.mjs` nu sunt aplicate niciodată în CI.

`.github/CODEOWNERS` conține o singură regulă: `* @Constantin1968` — orice modificare cere recenzia proprietarului unic. `docs/BRANCH_PROTECTION.md` precizează că setările de protecție „should be configured manually in GitHub repository Settings" — nu sunt versionate, deci nu sunt verificabile din clonă.

---

## 8. Scripturi și servicii

### 8.1 `scripts/` — 19 fișiere, 3.184 de linii

| Fișier | Linii | Ultima atingere | Autor | Ce face |
|---|---|---|---|---|
| `verify-live.py` | 518 | 2026-08-03 | AMB (Archeon Master the Best) | Verificare live a instalării desfășurate |
| `benchmark-retrieval.ts` | 407 | 2026-08-02 | AMB, COO | Benchmark de regăsire R-Knowledge (MIP-014 STEP 2, poarta G7). Distinge trei clase de metrică cu autoritate diferită: poarta de release (acuratețe de citare = 1.000 și completitudine de proveniență = 1.000, fără renunțare posibilă) de calificarea operațională, care nu blochează build-ul |
| `verify-knowledge-conformance.ts` | 381 | 2026-08-20 | Constantine Liviu NITA | Verificare de conformitate a planului R-Knowledge; rulat de job-ul CI `knowledge-conformance` |
| `knowledge-equivalence-report.py` | 219 | 2026-08-19 | AMB | Compară observațiile în mod dezactivat și activat capturate de `knowledge-equivalence.sh` și emite un verdict citibil de mașină. Documentează explicit că rularea în mod activat e controlul care demonstrează că harnessul *poate* detecta o diferență |
| `knowledge-rollback-drill.sh` | 202 | 2026-08-02 | AMB, COO | Execută reversarea într-un **worktree separat**, astfel încât exercițiul să nu poată deteriora ramura pe care o testează. Declară explicit că identitatea de commit nu este criteriu de acceptare |
| `automation-bootstrap.sh` | 190 | 2026-08-24 | Merlin the Ancient Architect | Bootstrap idempotent, non-distructiv al activării: creează exact ce auditează preflight-ul — trei rețele Docker, directorul de secrete cu permisiuni limitate, perechea de chei Ed25519 pentru chitanțe, directoarele de artefacte/nonce și clona dedicată. Nu suprascrie niciodată un secret existent, nu tipărește material secret, nu pornește niciun container, nu atinge stiva de producție |
| `generate-sbom.py` | 168 | 2026-08-03 | AMB | Generator SBOM CycloneDX 1.5 din `package.json` (intervale declarate) și `package-lock.json` (versiuni resolvate, hash-uri de integritate, licențe) |
| `provision-qdrant.ts` | 158 | 2026-08-03 | AMB | Creează cele trei colecții Qdrant cerute de v0.5.0 (`ronor_memory`, `ronor_knowledge`, `ronor_missions`, `text-embedding-3-small`, 1536d) dacă nu există. Sigur la reexecuție |
| `verify-chain.ts` | 130 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Verificator offline al lanțului de audit, destinat unei bănci, unui regulator TSO, unui asigurător sau unui client OSaaS. Rehash-uiește fiecare înregistrare de la geneză la cap și raportează punctul exact de rupere. Expus prin `npm run verify-chain` |
| `benchmark.ts` | 128 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Benchmark decizional guvernat vs. neguvernat pe N sesiuni BESS; emite tabel cu net € mediu de referință, net € guvernat, câștig verificat și ratele de acțiune blocată / escaladată / co-semnată. Expus prin `npm run benchmark` |
| `knowledge-equivalence.sh` | 122 | 2026-08-02 | AMB, COO | Harness de echivalență la rulare (poarta G5 ABSOLUTĂ): bootează runtime-ul compilat în mod dezactivat și activat și înregistrează diferența observabilă. Notează că bootarea folosește `node dist/index.js` fiindcă `ts-node src/index.ts` nu bootează nici la commit-ul de referință |
| `provision-supabase.ts` | 116 | 2026-08-03 | AMB | Execută migrarea `deploy/sql/001_ronor_schema.sql` prin Supabase Management API (`POST /v1/projects/{ref}/database/query`), nu prin conexiune Postgres directă, ca să nu fie nevoie de parola bazei |
| `fresh-clone-smoke-test.sh` | 105 | 2026-07-21 | Constantin Liviu NITA (Merlin) | Reproduce procedura exactă a unui jurat Build Week: totul de la o clonă curată. Comentariul indică `git clone -b build-week` |
| `automation-preflight.sh` | 79 | 2026-08-21 | Constantine Liviu NITA | Audit **strict de citire** al activării automatizării: nu creează rețele, fișiere, containere sau credențiale și nu tipărește material secret. `umask 077`. Rulat de job-ul CI `automation-preflight` |
| `probe-providers.ts` | 71 | 2026-08-03 | AMB (Archeon Master the Best) | Sondează fiecare adaptor de provider cu credențialele existente în mediu și tipărește o linie pe provider — răspunde la „is my exchange live?" fără să trimită o cerere guvernată |
| `deploy.sh` | 53 | 2026-07-20 | Constantin Liviu NITA (Merlin) | Desfășurare pe Railway prin CLI |
| `generate-source-checksums.sh` | 43 | 2026-08-03 | AMB | Emite digest-uri SHA-256 pentru fiecare fișier urmărit de git, în ordine deterministă de cale, excluzând fișierul de checksum. Produce `checksums.sha256` |
| `generate-checksums.sh` | 41 | 2026-08-01 | AMB | Generează checksum-uri SHA-256 pentru artefactele de release; ia versiunea din `package.json`. Expus prin `npm run checksum` |
| `openhands-secret-entrypoint.sh` | 23 | 2026-08-22 | Constantine Liviu NITA | Entrypoint `sh` care citește secretele din fișierele montate și **refuză pornirea cu cod 78** dacă un fișier de secret lipsește, e necitibil sau e gol |

### 8.2 Nu există director `services/` la nivel de rădăcină

`ls -d services` → `No such file or directory`. Serviciile automatizării se află la `src/runtime/automation/services/` — 11 fișiere, **616 linii**:

| Fișier | Linii | Ultima atingere | Autor | Rol |
|---|---|---|---|---|
| `openhands-bridge.ts` | 170 | 2026-08-21 | Constantine Liviu NITA | Punte către executorul OpenHands (`POST /v1/execute`) |
| `verification-authorities.ts` | 102 | 2026-08-21 | Constantine Liviu NITA | Aplicațiile de autoritate Codex și Victoria, montabile independent |
| `langgraph-local.ts` | 78 | 2026-08-21 | Constantine Liviu NITA | Serviciu LangGraph local, port 2024 |
| `model-egress-proxy.ts` | 70 | 2026-08-21 | Constantine Liviu NITA | Proxy de egress de model — OpenHands și Codex se autentifică cu identități de client separate |
| `codex-evaluator.ts` | 57 | 2026-08-21 | Constantine Liviu NITA | Legarea live a evaluatorului Codex la provider |
| `openhands-bridge-server.ts` | 37 | 2026-08-22 | Constantine Liviu NITA | Server HTTP pentru punte, port 3001 |
| `evidence-runner.ts` | 29 | 2026-08-21 | Constantine Liviu NITA | Rulează testele permise izolat de runtime |
| `verification-authorities-server.ts` | 24 | 2026-08-21 | Constantine Liviu NITA | Server pentru `codex` (3002) sau `assurance` (3003), selectat prin argument |
| `evidence-runner-server.ts` | 19 | 2026-08-24 | Merlin the Ancient Architect | Server pentru rulătorul de dovezi |
| `secret-files.ts` | 15 | 2026-08-20 | Constantine Liviu NITA | Citire de secrete din fișiere montate |
| `model-egress-proxy-server.ts` | 15 | 2026-08-21 | Constantine Liviu NITA | Server pentru proxy, port 3004 |

### 8.3 `deploy/` — 5 fișiere, 1.414 linii, toate de AMB, 3 august 2026

| Fișier | Linii | Rol |
|---|---|---|
| `setup-server.sh` | 521 | Pregătirea serverului |
| `deploy.sh` | 386 | Desfășurare |
| `sql/001_ronor_schema.sql` | 249 | Schema Postgres/Supabase |
| `nginx/ronor.conf` | 218 | Configurație reverse-proxy |
| `nginx/ssl-params.conf` | 40 | Parametri TLS |

### 8.4 Containerizare — 9 fișiere

`docker-compose.automation.yml` (280 linii, 24 aug, Merlin), `docker-compose.production.yml` (317, 19 aug, AMB), `docker-compose.yml` (244, 19 aug, AMB), `docker-compose.automation-runtime.yml` (26, 21 aug), `docker-compose.test.yml` (25, 1 aug, AMB); `Dockerfile` (62, 20 iul), `Dockerfile.evidence-runner` (21, 21 aug), `Dockerfile.automation-runtime` (8, 21 aug), `Dockerfile.openhands-agent` (7, 21 aug). Cinci fișiere compose coexistă fără un document care să explice care e canonic pentru care mediu.

---

## 9. Datorii și incoerențe descoperite

1. **Ramura locală `main` e cu 2 commit-uri în urma lui `origin/main`.** `git rev-list --left-right --count main...origin/main` → `0	2`. Referința locală indică `264a55b` (PR #23), în timp ce `origin/main` e la `44f3798` (PR #25). Orice comandă rulată împotriva ramurii locale `main` — inclusiv un preflight de automatizare care compară HEAD cu SHA-ul aprobat — va evalua o stare depășită. HEAD-ul detașat curent, în schimb, e corect sincronizat.

2. **Două ramuri remote raportate „neintegrate" nu conțin niciun conținut nou, iar aplicarea lor ar fi o regresie.** `origin/chore/unpin-approved-sha` (2 commit-uri în avans) ar elimina cele patru variabile `RONOR_AUTOMATION_*_HOST_PORT` și ar rehardcoda porturile `2024/3001/3002/3003` în `docker-compose.automation.yml`. `origin/automation/parameterize-host-ports` (1 commit în avans) ar reintroduce `RONOR_AUTOMATION_EXPECTED_HEAD=0f80a608...` hardcodat, exact ce PR #24 a scos intenționat. Ambele sunt instantanee pre-squash și trebuie șterse, nu integrate.

3. **24 de ramuri remote de feature pentru un istoric de 164 de commit-uri, dintre care 22 sunt strămoși integrali ai `main`.** Nicio ramură nu a fost curățată după merge. Rezultatul practic: `git branch -a` nu mai poate fi folosit pentru a răspunde la „ce e în lucru", fiindcă semnalul e complet acoperit de zgomot istoric.

4. **Versionarea nu are o singură sursă de adevăr.** `package.json` declară `2.0.0-build-week`; `RELEASE_MANIFEST.md` declară `0.4.0-core-active`; cea mai recentă etichetă e `v0.5.0-20260819`; cea mai mare etichetă semantică e `v2.1.0-baseline`. Numerotarea scade în timp (`v2.1.0` pe 1 august → `v0.4.0` pe 3 august). `scripts/generate-checksums.sh` citește versiunea din `package.json`, deci artefactele generate vor purta eticheta seriei abandonate.

5. **`RELEASE_MANIFEST.md` fixează un „Release commit" (`bbed8343...`) diferit de commit-ul indicat de eticheta pe care o descrie** (`v0.4.0-core-active` → `57f4379`). Manifestul nu e verificabil împotriva repo-ului.

6. **`CHANGELOG.md` afirmă că nu mai există lucru în curs, la 3 săptămâni și ~60 de commit-uri distanță de realitate.** Secțiunea `[Unreleased]`: „No changes are pending... closed the last open engineering item on `main`." Nu există intrare de changelog pentru `v0.5.0-20260819` și nici pentru programul de automatizare din 19–24 august. Ultima atingere a fișierului: 3 august 2026.

7. **Starea curentă a `main` nu e etichetată și nu a trecut niciodată prin `release.yml`.** Workflow-ul se declanșează doar pe `push` de etichete `v*`; ultima etichetă e din 19 august. Întreg kitul de activare a automatizării (PR #22–#25) a intrat pe `main` fără verificare de release.

8. **Scanarea de secrete e neblocantă.** `.github/workflows/ci.yml:71` — pasul TruffleHog are `continue-on-error: true`, deci `--fail` nu are efect asupra pipeline-ului. Un secret verificat comis în istoric ar produce un CI verde.

9. **ESLint nu rulează niciodată în CI.** `package.json` definește `lint` (`eslint src --ext .ts`) și `typecheck` (`tsc --noEmit`), iar `eslint.config.mjs` există în repo, dar niciun job din `ci.yml` nu îi invocă. Verificarea de tip se face doar indirect, prin `npm run build`.

10. **`npm run seed` referă un fișier inexistent.** `package.json` declară `"seed": "ts-node scripts/seed.ts"`; `ls scripts/seed.ts` → `No such file or directory`. Script de pachet mort.

11. **Scripturile de provizionare sunt duplicate în două locuri, cu implementări divergente.** `scripts/provision-qdrant.ts` folosește `client.api('cluster').clusterStatus()`, iar `src/scripts/provision-qdrant.ts` folosește `client.versionInfo()` — două apeluri diferite pentru aceeași verificare de disponibilitate, pe același `@qdrant/js-client-rest@1.18.0`. `provision-supabase.ts` e duplicat în ambele locuri cu diferență doar de cale de import. Niciunul din cele patru fișiere nu e referit din `package.json`; nu se poate stabili din repo care variantă e cea corectă.

12. **825 de linii de cod fără nicio referință de import și fără punct de intrare.** `src/model-exchange/engines.ts` (329 linii, zero rezultate la grep, corespondent istoric în arhiva v0.1), `src/persistence/memory-manager.ts` (222 linii, expune un singleton `getMemoryManager()` neapelat), plus cele două duplicate `src/scripts/provision-*.ts` (274 linii).

13. **Puntea Telegram, 2.140 de linii, nu e montată nicăieri.** Comentariul din `src/interfaces/telegram/index.ts:11` afirmă că `startTelegramBridge()` e destinat apelării din `src/index.ts`, dar acel apel nu există. Nu există nici serviciu dedicat în niciunul din cele cinci fișiere `docker-compose*.yml`. Codul are totuși teste care trec, deci CI-ul nu semnalează situația: 2.059 de linii în `src/interfaces/telegram/` plus 81 în `src/interfaces/tailscale/` sunt testate, dar nu executabile în vreo configurație livrată.

14. **Trei orchestratoare, 891 de linii, sub același nume de bază.** `src/orchestrator.ts` (156), `src/decision-loop/orchestrator.ts` (351), `src/model-exchange/orchestrator.ts` (384). Toate trei sunt referite, deci niciunul nu e mort, dar limita de responsabilitate dintre ele nu e documentată în niciun fișier `.md`.

15. **Două suprafețe HTTP paralele, cu stiluri opuse.** `/api/runtime` e servit de un singur fișier de 1.220 de linii (`src/runtime/api/routes.ts`), iar `/api/v1` de cinci fișiere însumând 734 de linii. Cele două sunt montate una lângă alta în `src/index.ts` (liniile 246–256), fără document care să explice ce cerere aparține cărei suprafețe.

16. **Coliziune de nomenclatură „router".** `src/api/*-router.ts` (routere HTTP Express), `src/runtime/router/` (6 fișiere, 1.435 de linii — motor de selecție de model, nu HTTP) și `src/model-exchange/router.ts` (119 linii, moștenit) folosesc același termen pentru trei concepte diferite. Similar pentru „gateway": `src/planes/r-gateway/index.ts` (plan de guvernanță) vs. `src/runtime/providers/gateway.ts` (adaptor de provider), și pentru „work-ledger": două implementări, 517 linii cumulat.

17. **Atribuirea AI nu e verificabilă din istoricul git.** Există un singur trailer `Co-authored-by` în 167 de commit-uri, iar el numește identitatea de serviciu `RONOR Ops <ops@ronor.local>`. Toată atribuirea către Codex și GPT-5.6 trăiește exclusiv în proză, în `DEVPOST_SUBMISSION.md`, `README.md`, `VIDEO_SCRIPT.md` și `YOUTUBE_LISTING.md`. Un audit care s-ar sprijini doar pe metadatele git ar concluziona că repo-ul e 100% scris de om.

18. **Grep-ul naiv pe „codex" supraestimează masiv atribuirea AI, fiindcă „Codex" e numele unui serviciu al arhitecturii.** Din 22 de potriviri în mesajele de commit, una singură e un trailer real, una e o linie de atribuire în proză, iar 20 sunt termeni de domeniu — `codex-verifier` e un container cu port 3002, șase secrete dedicate și o cheie Ed25519 de semnare (`docker-compose.automation.yml:142–156`). Orice instrument de conformitate care caută semnături de agent în acest repo trebuie să distingă între cele două sensuri.

19. **Dovada de utilizare Codex cerută de regulamentul hackathon-ului nu a fost niciodată completată.** `DEVPOST_SUBMISSION.md:97` conține încă `[session ID from /feedback — added at submission]`, iar `docs/reference/model-exchange-v0.1-original/DEVPOST_SUBMISSION.md:37` conține `[ADD URL]`. Placeholder-e rămase în documentul de submisie comis.

20. **Un artefact de dovadă e complet gol.** `evidence/knowledge/fs-diff-disabled.txt` are 0 octeți (`find evidence -size 0 -type f`). Vidul este, prin construcție, dovada că nu s-a scris nimic pe disc în mod dezactivat — dar un fișier de zero octeți e indistinct de o captură eșuată, iar dosarul nu conține nicio atestare separată care să afirme că golul e intenționat.

21. **Întreg dosarul de dovezi atestă o stare de acum trei săptămâni.** Toate cele 21 de artefacte din `evidence/knowledge/`, inclusiv `sbom.json` (2.236 linii) și `conformance-report.json`, au fost comise pe 2 august 2026. Codul a avansat cu ~60 de commit-uri de atunci. `SBOM.json` și `checksums.sha256` de la rădăcină provin din aceeași epocă (`scripts/generate-source-checksums.sh`, 3 august) și nu mai corespund arborelui urmărit actual.

22. **43 din 47 de documente `.md` sunt stagnante** (neatinse de la 11 august 2026 sau mai devreme). Cele patru actualizate — `docs/executive-automation.md`, `docs/mission-state-fabric.md`, `docs/control-executive-council.md`, `docs/qwen-benchmark-2026-08-20.md` — sunt toate scrise de Constantine Liviu NITA în 20–21 august și acoperă exclusiv automatizarea. `README.md` (ultima atingere 2 august) nu menționează niciuna din capabilitățile adăugate în ultimele trei săptămâni.

23. **1.647 de linii de briefuri QMa11 și 25 de fișiere de prototip arhivat sunt versionate ca documentație de proiect.** Cele nouă briefuri (`docs/qma11-*`) sunt material de referință pentru narativul unei submisii din iulie, comise toate într-o singură zi. `docs/reference/model-exchange-v0.1-original/` conține un al doilea proiect complet, cu propriul `package.json`, `render.yaml`, client React și server Express. Ele nu se compilează, nu se testează și nu sunt referite din codul activ, dar apar în `git ls-files` alături de codul de producție și în orice generare de checksum pe fișiere urmărite.

24. **Cinci fișiere `docker-compose*.yml` coexistă fără document de departajare.** `docker-compose.yml`, `.production.yml`, `.automation.yml`, `.automation-runtime.yml`, `.test.yml`. `release.yml` împachetează în arhiva de release doar `docker-compose.yml`, deci configurația de automatizare — 280 de linii, cea mai recent modificată — nu ajunge în artefactul de release.

25. **Politica de protecție a ramurii nu e versionată, deci nu e verificabilă.** `docs/BRANCH_PROTECTION.md` declară că setările „should be configured manually in GitHub repository Settings > Branches". `.github/CODEOWNERS` are o singură regulă (`* @Constantin1968`), iar `main` are un singur proprietar și un singur revizor — care coincide cu autorul a 117 din 167 de commit-uri. Din clonă nu se poate stabili dacă vreo regulă de protecție e efectiv activă.

26. **Personele de autor multiplică identitățile fără registru.** Aceeași persoană comite sub cinci nume de afișare și trei adrese; persona „AMB" apare sub trei nume și trei adrese (`amb@mayleven.com`, `office@mayleven.com`, `constantine@mayleven.com`), iar `office@mayleven.com` e folosită atât de „AMB (Archeon Master the Best)" cât și de „Constantin Liviu NITA". Nu există `.mailmap` și nici un document care să explice cartografierea. Orice statistică de contribuție calculată pe acest repo va fi greșită.

---

## Anexă — comenzi executate

Toate comenzile au fost rulate în `/home/user/workspace/ronor`, exclusiv de citire:

```
git log -1 --format='%H %ad %an'
git branch -a -v
git tag -l
git stash list
git worktree list
git status --short
git status --porcelain --untracked-files=all
git status --porcelain --ignored
git ls-files
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes
git rev-list --left-right --count origin/main...<ramura>
git rev-list --left-right --count main...origin/main
git rev-list --all | wc -l ; git rev-list origin/main | wc -l
git log -1 --format='%h|%ad|%an|%ae|%s' --date=iso <ramura>
git log origin/main..<ramura> --format='%H|%an|%ae|%ad|%s' --date=iso
git log origin/main..<ramura> --stat
git diff --stat origin/main <ramura> ; git diff origin/main <ramura>
git rev-list -n1 <etichetă> ; git cat-file -t <etichetă>
git merge-base --is-ancestor <sha> origin/main
git fsck --lost-found ; git fsck --unreachable --dangling
git reflog | wc -l
git log --all --format='%an <%ae>' | sort | uniq -c | sort -rn
git log --all --format='%cn <%ce>' | sort | uniq -c | sort -rn
git log --all --format='%H|%an|%ae|%s|%b' | grep -icE 'codex|manus|co-authored|generated with|claude|gpt|assistant|agent'
git log --all --grep='Co-authored-by' -i
grep -rniE 'codex|manus' --include='*.md' --include='*.json' --include='*.yml' --include='*.yaml' --include='*.txt'
git log -1 --format='%ad|%an' --date=short -- <fișier>
find src -mindepth 1 -maxdepth 2 -type d ; find <dir> -maxdepth 1 -name '*.ts' -exec cat {} + | wc -l
git ls-files 'src/*' | xargs -n1 basename | sort | uniq -c | sort -rn
grep -rIl --include='*.ts' --include='*.js' -E "from '[^']*/<modul>'|require\(...\)" src tests scripts
diff scripts/provision-qdrant.ts src/scripts/provision-qdrant.ts
find evidence -size 0 -type f
wc -l <fișier>
```
