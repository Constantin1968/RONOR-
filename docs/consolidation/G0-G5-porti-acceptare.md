# Porți de acceptare RONOR G0–G5 — checklist cu probe negative

> Sursă: Audit aprofundat RONOR 09.09.2026 (18 constatări F01–F18) + doctrina The New Renaissance v3.0 (claims register, falsifiabilitate).
> Regulă transversală din doctrină: **o afirmație nu călătorește mai departe decât dovada sa**. Fiecare poartă se închide doar cu rezultate observabile, nu cu text de instrucțiuni, comentarii sau etichete de stare noi.
> Proprietăți, nu șiruri: fiecare test de mai jos e formulat ca proprietate negativă (`după X nu există Y`).

Stare curentă la baseline `main` (`a857989`): prototip avansat cu guvernanță implementată, **necertificat** pentru autonomie extinsă / producție. Vezi `RONOR_Audit_Aprofundat_2026-09-09`.

---

## G0 — Expunere și acces (F01, F14)

**Întrebarea porții:** poate un anonim sau o cheie revocată să atingă o rută sensibilă?

| # | Proprietate (trebuie să țină) | Unde se verifică în cod | Cum se probează |
|---|---|---|---|
| G0.1 | Fără token → `401/403` pe **fiecare** citire sensibilă și scriere, pe app **și** prin proxy | `src/index.ts` (montare `/api/v1` vs `/api/runtime`), `src/api/router.ts`, `deploy/nginx/ronor.conf`, `docker-compose.yml` (port publicat fără loopback) vs `docker-compose.production.yml` | Matrice fără token: `GET /api/v1/audit/*`, `POST /api/v1/cosign/*` cu `recordId+operator` declarat, `POST /api/runtime/*`, `GET /api/runtime/*`. Așteptat: toate `401/403`. Azi F01 arată `200` pe eliberare cosign cu identitate declarată → POARTĂ DESCHISĂ |
| G0.2 | Identitatea cosemnatarului derivă din cheie, niciodată din corpul cererii | `src/api/router.ts:74,93` | Reluare probă audit `unauthenticated_cosign_release` cu server local. Criteriu: `200` doar cu cheie validă + `operator == key_subject` |
| G0.3 | După revocare nu există autentificare, nici după restart | `src/runtime/api/auth.ts:83,137,259,274` (`upsertApiKey` + `bootstrapApiKeys`) | Secvență: creează cheie fictivă → revocă → auth = `401` → rulează `bootstrap` → auth tot `401`. Azi proba arată reactivare → POARTĂ DESCHISĂ. Remediere cerută: bootstrap inserează doar chei absente, respectă flagul persistent de revocare; reactivarea e acțiune explicită auditată |
| G0.4 | Inventar de rute publicat: sensibile vs. publice, cu mecanismul de auth per rută | — | Fișier `docs/consolidation/inventar-rute.md` generat din cod + test care pică dacă apare rută sensibilă nouă fără auth |

**Criteriu de închidere G0:** matricea fără token e verde pe app + prin nginx; secvența revocare→restart e verde; inventarul e versionat.

---

## G1 — Separarea executorului (F02, F03, F04, F09)

**Întrebarea porții:** poate codul neîncrezut să iasă din capabilitatea declarată?

| # | Proprietate | Unde | Probă |
|---|---|---|---|
| G1.1 | Cu doar `read_repo` nu există scriere, comitere sau ștergere, indiferent de formă (direct, via `python`, via cale `/run/secrets`) | `src/runtime/automation/effect-policy.ts:14`, `src/runtime/automation/pending-openhands-actions.ts` (`evaluateOpenHandsEffects`/`evaluatePendingOpenHandsActions`) | Probe text existente: `readonly_write`, `readonly_git_commit`, `readonly_delete` trebuie **toate refuzate**; control pozitiv `blocked_push` refuzat. Azi primele 3 sunt aprobate → POARTĂ DESCHISĂ. Remediere: operații tipizate (read/edit/test/commit) cu argv validat + constrângeri OS; `read` rulează pe arbore read-only; commit-ul îl face un serviciu îngust, nu interpretul general |
| G1.2 | Din interiorul executorului nu se citesc secrete fictive și nu se atinge control-plane-ul | `docker-compose.automation.yml` (același container/user `10001` pentru server OpenHands + scule, rețele `automation-control` + `model-egress`), `effect-policy.ts` (permite textual `cat /run/secrets/fixture_token`) | Pornire sandbox → `cat $SESSION_SECRET_FIXTURE` = refuz; `curl openhands-server:port` = refuz; `cat /run/secrets/*` = refuz. Remediere: server control separat de sandbox; sandbox fără session secret / cheie semnare, fără rute spre API-uri admin |
| G1.3 | Testele nu scriu în directorul dovezilor și nu văd secrete de serviciu | `src/runtime/automation/test-executor.ts:1,10,34` (`createAllowlistedTestExecutor` fără user/namespace separat), `docker-compose.automation.yml` (`/artifacts` rw + secret serviciu) | Probă `test_child_same_user_can_write_artifact` trebuie să devină refuz după remediere: testele rulează în sandbox efemer fără `/artifacts` și fără secrete; doar supervisorul de încredere colectează stdout/exit/version și semnează raportul |
| G1.4 | Două mandate pe același arbore nu primesc ambele `acquired` | `src/runtime/automation/run-lease.ts:162,194` (lease pe `run_id`/`mandate_id`, nu pe calea canonică), `src/runtime/api/routes.ts` | Concurență reală: 2 cereri paralele pe aceeași cale → una admisă, cealaltă refuzată sau rutată pe checkout separat. Azi proba `two_runs_same_workspace_acquire_leases` dă dublu `acquired` → POARTĂ DESCHISĂ. Remediere: checkout propriu per misiune sau lease persistent unic pe arbore verificat tranzacțional înainte de dispatch |

**Criteriu de închidere G1:** toate cele 4 probe negative verzi + test de concurență în CI.

---

## G2 — Contract și rezultat (F05, F06, F07)

**Întrebarea porții:** dovada testelor descrie exact arborele final, pentru obiectivul aprobat, cu instrucțiunea autorizată?

| # | Proprietate | Unde | Probă |
|---|---|---|---|
| G2.1 | După orice modificare de un octet post-teste nu mai există receipt valid | `src/runtime/automation/services/langgraph-local.ts:38` (sarcina finală doar `commit_local`), `src/runtime/automation/runner.ts:208,216` (`runTests` din `assignment.actions.includes('run_tests')` → `false` pe final) | Probă `final_commit_not_retested`: planifică → testează → modifică 1 octet → cere acceptare → **refuz**. Remediere: îngheață snapshot după ultima modificare → testează snapshot-ul → comite exact arborele verificat prin operație fără editare; receipt leagă mandat+obiectiv+plan+arbore+commit+raport+încercare+versiune politică teste |
| G2.2 | Evaluatorul primește obiectivul autoritativ; un diff corect sintactic dar fără legătură cu obiectivul e respins | `src/runtime/automation/services/codex-evaluator.ts:26,35` (trimite `mission_id, claims, materials`, fără `objective`), `langgraph-local.ts:38` (commit fără obiectiv) | Captură cerere evaluator: câmp `objective` prezent din controller, nu din afirmațiile worker-ului; probă mutație: diff valid dar off-objective → verdict `reject` cu motiv. Azi `verifier_input_has_no_objective` + `commit_omits_objective` → POARTĂ DESCHISĂ. Se înregistrează model, versiune instrucțiuni, furnizor în receipt |
| G2.3 | Orice schimbare de un octet în instrucțiune / plan / arbore / politică teste / buget invalidează capabilitatea | `src/runtime/automation/capability.ts:3,19,26,34` (semnează obiectiv-hash+task+acțiuni+expirare, nu `instruction`), `src/runtime/automation/services/openhands-bridge.ts` | Probe `capability_accepts_unsigned_instruction` + `changed_instruction_reaches_adapter`: instrucțiune schimbată + capabilitate validă → azi `200` la adaptor → trebuie `403`. Remediere: semnătura acoperă plic canonic complet (instrucțiune, hash plan, sarcină, arbore, politică teste, încercare, buget) |

**Criteriu de închidere G2:** cele 3 mutații respinse automat; receipt-ul conține toate legăturile.

---

## G3 — Reluare și anulare (F08, F15)

| # | Proprietate | Unde | Probă |
|---|---|---|---|
| G3.1 | La reluare nu se pierd afirmații independente și nu se inventează costuri; coliziunea de artefact e imposibilă prin design | `src/runtime/automation/runner.ts:193,225,227` (finalul păstrează `result.evidence` = afirmațiile worker-ului, nu `workerClaims` + verificator), `src/runtime/automation/artifacts.ts:62` (`artifact_collision` pe același `runId+assignmentId`) | Probe: întrerupe după execuție / după teste / înainte de acceptare → reia → `tests:pass` independent persistă; a doua încercare scrie în director propriu, pachetul final selectă determinist ultima încercare acceptată. Azi `resume_loses_independent_test_claim` + `retry_artifact_collision` → POARTĂ DESCHISĂ |
| G3.2 | După anulare nu există proces de test activ după intervalul definit | `src/runtime/automation/services/evidence-runner.ts`, `test-executor.ts` (`spawnSync` blochează event-loop; `AbortSignal` verificat doar înainte de comenzi, netransmis pe HTTP) | Anulează misiunea în timpul `config.tests.run` → toate procesele + descendenții terminați în < N sec (definit, ex. 10s); raport explicit `interrupted`. Remediere: lansare asincronă cu deadline absolut + kill grup procese de către supervisor |

**Criteriu de închidere G3:** 3 scenarii de întrerupere verzi + proba de kill verde, fără costuri inventate.

---

## G4 — Buget și cunoaștere (F10, F11, F12)

| # | Proprietate | Unde | Probă |
|---|---|---|---|
| G4.1 | Nicio cerere facturabilă nu depășește rezerva; buget zero admite doar operații fără cost sau refuză explicit | `src/runtime/router/policy.ts:37,221,223,227` (estimare din caractere + 900 tok output presupus), `src/runtime/router/exchange.ts:199` (până la 8192 + retry multi-model), vs `src/runtime/automation/model-budget.ts` + `model-egress-proxy.ts` (rezervare reală doar pe traseul automation) | Furnizor simulat: cerere plafon `0.04 USD` cu cost catalog `0.24626 USD` → azi `succes` → trebuie `refuz / rezervare insuficientă`; `max_cost_usd=0` cu candidat plătit → azi admis → trebuie refuz. Remediere: același registru de rezervări pentru query/agent/embedding/condensare/verificare; retry-urile consumă din aceeași rezervă |
| G4.2 | Cererile suverane fără traseu demonstrabil sunt refuzate | `src/runtime/api/governance-bridge.ts:102,107` (`residencyFor` → constant `eu`), `src/runtime/router/exchange.ts` | Probă `sovereign_residency_is_constant`: pentru fiecare etapă care transmite conținut se înregistrează furnizor+endpoint+regiune contractuală+categorie date; filtrarea MI9 se reevaluează pe modelul efectiv ales, inclusiv fallback; embedding/rezumate incluse |
| G4.3 | Două fragmente din același document nu produc automat consens; citare inventată respinsă/eliminată | `src/runtime/knowledge/bridge.ts`, `src/runtime/api/pipeline.ts:208`, `src/runtime/api/governance-bridge.ts:140` (`consensusReached = sourceCount>=2`), `src/knowledge/rag.ts:200` (`verifyAndStripCitations` definit, neintegrat în traseul final) | Test: 2 fragmente același `doc_id` → `consensusReached=false`; test: citare cu id inexistent → respins/eliminat explicit + urmă în log; actualitatea se măsoară pe dovezile relevante, nu pe `min(varste)` |

**Criteriu de închidere G4:** plafon agregat demonstrat cu furnizor simulat; traseu de date per etapă; teste RAG verzi.

---

## G5 — Livrare și recuperare (F13, F16, F17, F18)

| # | Proprietate | Unde | Probă |
|---|---|---|---|
| G5.1 | Trunchierea lanțului e detectată; rescrierea integrală nu trece drept validă | `src/audit/hash-chain.ts:134,161` (`verifyChain` → `ok=true` după ștergerea ultimei verigi), `:10,293` (`canonicalStringify` coliziune referință comună → `null`), `append` ne-tranzacțional | Probe `truncated_chain_passes_self_check` + `canonical_repeated_reference_collision` → după remediere: cap+lungime ancorate periodic într-un registru separat semnat anti-rescriere; `append` tranzacțional; serializare doar JSON valid; restaurarea compară ancora externă |
| G5.2 | CI verde înseamnă ceva: porți obligatorii, legate de commit/lockfile/imagine/politică teste | `.github/workflows/ci.yml` (doar push/PR spre main, nu pe ramuri automation; `testMatch` exclude `.mjs`/`.cjs`; secrete `continue-on-error:true`; `npm audit` blochează doar `critical`), `jest.config.js`, `tests/knowledge/qdrant-adapter.test.ts` (MTA-2b `undici` vs listă, MTA-2c-d cere `.git` absent) | Matrice publicată: jest complet + CLI mjs/cjs + teste negative securitate + scan secrete obligatoriu (fără continue-on-error) + `npm audit` cu triaj (azi 8 pachete: 3 high `brace-expansion, browserslist, js-yaml` din care `js-yaml` direct, 5 moderate). Artefactele CI poartă commit+lockfile+digest imagine+versiune politică teste. MTA-2b se închide prin decizie înregistrată (aprobă+adaugă vs scoate dependența), nu prin editare oarbă a testului |
| G5.3 | Stiva care rulează e reconstituibilă dintr-un manifest; restaurarea e probată pe mediu separat, cu RPO/RTO măsurați | `scripts/install-development-runtime-window.sh` (căi spre release-uri istorice multiple, verificare doar `ledger.db` prin `sha256sum` deși SQLite WAL ține stare și în `-wal`), `docker-compose.development-*.yml` | Manifest rezolvat: serviciu+digest imagine+commit+volume+rețea+user+politică+secrete prin identificatori (fără valori). Restaurare pe gazdă goală: lanțuri verificate + acces verificat; snapshot SQLite coerent (checkpoint controlat); RPO/RTO măsurați prin probă, nu deduși din frecvența copierii |
| G5.4 | Runtime suportat oficial, imagini fixate prin digest | `Dockerfile.development-tools`, CI (Node 20 EOL la data auditului) | Migrare comună runtime+imagine agent+runner+`better-sqlite3` nativ pe LTS suportat; compatibilitate demonstrată înainte de switch; imagini pin-uite prin digest |

**Criteriu de închidere G5:** ancoră externă + CI obligatoriu + restaurare pe gol demonstrată + LTS.

---

## Reguli de lucru

1. Fiecare poartă are owner pe componente: API+identitate, platformă execuție, verificare, contabilitate, operațiuni.
2. Nicio poartă nu se închide prin `patch` de teste fără remedierea cauzei (avertismentul auditului despre `automation-run-lease.test.ts` / `development-controller.test.ts` identice între arbori).
3. Orice afirmație publică nouă (`validat`, `suveran`, `autonom`, `câștig de productivitate`) intră în `docs/consolidation/claims-register.md` cu nivel de dovadă + test următor, conform Cap. 23 din doctrină.
