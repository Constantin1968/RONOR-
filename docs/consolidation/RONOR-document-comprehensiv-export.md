# RONOR — Document comprehensiv pentru export
## Stare, audit, porți de consolidare, probă și operator autonom

| Câmp | Valoare |
|---|---|
| Sistem | RONOR — Sovereign Intelligence Operating Runtime (RSIOR), nume scurt operațional: RONOR Orchestrator |
| Revizie de referință | `main` la `a857989` (după PR #41) |
| Audit de referință | Audit aprofundat RONOR, 09.09.2026 — arhiva `78e2e97f…51c69a`, 1.154 fișiere |
| Doctrină de referință | The New Renaissance, Expanded Canonical Edition v3.0, august 2026 |
| Data documentului | 16.09.2026 |
| Regim | Intern, exportabil către parteneri/investitori după avizul proprietarului |
| Documente-sursă în repo | `docs/consolidation/G0-G5-porti-acceptare.md`, `docs/consolidation/proba-45min-mandat-pachet.md`, `docs/consolidation/claims-register.md`, `docs/consolidation/operator-schelet.md` |
| Lucrări deschise | PR #42 (porți + probă + claims register), PR #43 (schelet operator Tranșa 1) |

> Regulă de lectură (din Cap. 23 al doctrinei): **o afirmație nu călătorește mai departe decât dovada sa**. Fiecare secțiune marchează explicit ce e măsurat, ce e demonstrat structural și ce rămâne de verificat. Formularile interzise până la închiderea porților sunt listate în §7.

---

## Cuprins

1. Rezumat executiv
2. Doctrina: The New Renaissance v3.0 — analiză și opinie
3. Sistemul: nomenclatură oficială și arhitectura reală
4. Auditul 09.09.2026 — constatări F01–F18 și semnificația lor
5. Porțile de consolidare G0–G5 — checklist
6. Proba minimală 45 min / 5 USD — mandat și pachet de acceptare
7. Operatorul Automatizat Autonom — schelet Tranșa 1 și drum complet
8. Registrul de afirmații și limbajul public permis
9. Roadmap și decizii
- Anexa A — Glosar
- Anexa B — Referințe și trasabilitate
- Anexa C — Istoricul versiunilor acestui document

---

## 1. Rezumat executiv

**Doctrina este solidă și onestă.** The New Renaissance v3.0 propune reconstrucția constituțională a civilizației în era inteligenței: limite productive, runtime constituțional, convertor de productivitate, suveranitate ca și capabilitate, authorship uman ca scop. Punctul ei distinctiv: se lasă atacată — Cap. 22 (obiecții), Cap. 23 (ce ar infirma-o), registru de afirmații, criterii de release pe 8 workstream-uri.

**Implementarea este un prototip avansat real, nu o demonstrație.** RONOR are mandate semnate, registre persistente, rutare guvernată, verificare Victoria, ledgers de cost/valoare/muncă, 1.420/1.422 teste Jest verzi pe arhiva auditată. Dar fotografia de cod din 09.09.2026 **nu justifică certificare de autonomie sigură sau pregătire integrală pentru producție**.

**Problema centrală stă la granițe:** ce declară sarcina că poate face vs. ce poate executa efectiv procesul vs. ce permit dovezile să fie acceptat. Separarea logică nu e peste tot separare de privilegii: 7 constatări P0 (F01–F06, F09, F14) blochează extinderea autonomiei.

**Recomandarea:** continuare controlată a dezvoltării pe porțile G0–G5 (§5), o singură probă minimală verificabilă 45 min / 5 USD (§6), apoi creșterea Operatorului pe scheletul Tranșa 1 deja implementat (§7). Pentru investitori/parteneri sunt defensabile doar formulările din §8.

---

## 2. Doctrina: The New Renaissance v3.0 — analiză și opinie

### 2.1. Obiect și structură

Volum de 178 pagini, autor Constantin Liviu Nita, Mayleven. Ediția extinsă v3.0 înglobează integral ediția canonică v2.1 fără alterare și adaugă secțiuni operaționale (taxonomii, teste, cazuri, moduri de eșec), orientări de Parte, obiecțiile 7–8, vinietele Cap. 24, materialul de caz 2026 (Cap. 13/15/30), Workstream 8, concordanța tematică.

Teza centrală: *Inteligența devine infrastructură civilizațională doar când observarea, raționamentul, decizia, execuția, verificarea, învățarea și memoria sunt reunite într-un sistem guvernabil, cu autoritatea finală legitimă la om.*

Șapte părți: (I) sfârșitul erei industriale; (II) noul strat — energie→informație, inteligența→infrastructură, computation→capital, runtime constituțional; (III) valoarea verificată vs. narată — productivity converter, OSaaS, baseline/counterfactual; (IV) noul stat — statul care învață, suveranitate, jocuri; (V) noul umanism — educație, muncă, refuz, Mayleven ca portofoliu de ipoteze; (VI) argumentul sub presiune — 12 propoziții, obiecții, falsifiabilitate, scenarii 2030–2050, program; (VII) coborârea în concret — proprietate/date/commons, democrație la viteza mașinii, România ca laborator.

### 2.2. Puncte forte

1. **Falsifiabilitate asumată.** Cap. 20 publică criteriile eșecului propriilor vehicule (inclusiv RONOR); Cap. 23 listează condițiile de infirmare per teză; agenda de cercetare promovează un workstream doar după o replicare independentă + o revizie adversarială.
2. **Registru operațional, nu slogan.** Vocabular controlat, claims register cu nivel de dovadă/disconfirmări/test următor, baseline pre-înregistrat, exit drill măsurat (timp/cost/capabilitate), safe state, frâne pre-autorizate. Lanțul `DOCTRINE → HYPOTHESIS → SPECIFICATION → PROTOTYPE → PILOT → EVALUATION → REPLICATION`.
3. **Ancorare în 2026 real.** Bill-ul de sovereign fund din Senatul SUA, settlement-ul de 1,5 mld USD din 20.07.2026 (antrenare pe cărți piratate vs. fair use pe material licit), piața de licensing ~3 mld USD, linia licit–ilicit trasată de instanțe, regimul opt-out european. Doctrina e testată pe prima luptă constituțională reală a inteligenței.
4. **Distincții practicabile:** limite protective/formative/moștenite/de camuflaj; pause/constrain/reserve/prohibit; nivelurile compliance/strategie/authorship; memorie fără supraveghere (`remember the decision, not the person`); achiziția ca meșteșug constituțional.

### 2.3. Limite și riscuri

1. Ambiție panoramică (energie, AI, stat, muncă, educație, proprietate, democrație) vs. dovezi încă subțiri — risc de reținere a viziunii fără disciplină.
2. Densitate mare; fără un circuit îngust funcțional cap-coadă, rămâne arhitectură pe hârtie.
3. Tensiuni numite onest dar nerezolvate prin text: suveranitate vs. eficiență, viteză vs. timp de înțelegere, distribuirea dividendului vs. concentrarea capitalului, factura metabolică a stratului inteligent.

### 2.4. Opinie

Peste media manifestelor tech: coerentă, citabilă, atacabilă — exact ce își propune. Valoarea ei pentru RONOR e normativă: definește busola (contract canonic semnat, snapshot→teste→commit legat, supervisor separat, evaluator cu obiectiv, contabilitate unică, exit repetat) după care auditul măsoară implementarea. Faptul că auditul găsește abateri de la aceste reguli confirmă necesitatea doctrinei, nu o infirmă.

---

## 3. Sistemul: nomenclatură oficială și arhitectura reală

### 3.1. Corecție de nomenclatură (25.08.2026, în vigoare)

- **Numele oficial:** RONOR — Sovereign Intelligence Operating Runtime (RSIOR).
- **Nume scurt operațional:** RONOR Orchestrator.
- **„Model Exchange & Governance Spine for Energy Operations"** (README, Devpost, `package.json`) = descriere de implementare a vitrinei, nu numele sistemului.
- **Consecință:** energia și BESS (scenariu 20 MWh România, date OPCOM day-ahead/aFRR) sunt **primul domeniu de probă, nu domeniul**. Arhitectura vizează extinderea la apărare, quantum, bio.
- **„Sovereign Generative Intelligence Runtime"** = numele doctrinar din carte (funcțiunea de generare guvernată). **„Sovereign Intelligence Operating Runtime"** = sistemul întreg (operarea cap-coadă). Generative e funcțiunea; Operating e sistemul.

### 3.2. Traseele de execuție (măsurat în audit)

| Traseu | Funcție reală | Limita principală |
|---|---|---|
| `/api/v1` (vechi) | Inferență, scenarii, audit, cosemnare veche, circuit BESS demonstrativ | Auth neuniformă, componente demonstrative/simulate |
| `/api/runtime` (nou) | Cereri guvernate, rutare 6D, agenți cu pașapoarte, registre, bugete | Bugete/rezidență/dovezi aplicate neuniform |
| Controller de dezvoltare | Misiuni aprobate, LangGraph → OpenHands → Codex → Victoria | Izolarea executorului + dovada rezultatului final |

### 3.3. Stadiul pe straturi canonice L0–L7 (august 2026, rezumat)

Livrate integral: L1 (suveranitate modele/compute), L4 (securitate/autoritate: MI9, `policies.yaml`, hash-chain). Parțiale: L0 (doar date scenariu BESS), L3 (pașapoarte + 3 workeri, stub-uri), L6 (doar Jest ad-hoc), L7 (doar Work Ledger; `verified_confidence=null` pe calea de interogare — veriga lipsă spre împărțirea 50/50). Inexistente ca strat separat: L2/L5 ca module distincte (funcții existente ca proiecții în `mission/store.ts`). În afara hărții dar construite: R-Sentinel, R-Knowledge, planul de execuție automatizată (`src/runtime`, cel mai mare modul).

### 3.4. Cifre de sănătate (arhiva auditată)

TypeScript `tsc --noEmit` trecut; Jest **1.420/1.422** (70/71 suite); CLI mjs 5/5, cjs 11/11; 24 probe de audit confirmate. Cele 2 eșecuri: MTA-2c-d (neportabil fără `.git`) și MTA-2b (neconcordanță reală `undici` în `package.json` vs. allowlist). CI: doar push/PR spre main, `testMatch` exclude CLI, secrete `continue-on-error`, `npm audit` blochează doar critical (local: 8 pachete — 3 high incl. `js-yaml` direct — 5 moderate, 0 critical). Node 20 EOL.

---

## 4. Auditul 09.09.2026 — constatări F01–F18 și semnificația lor

Metodă: trei niveluri (reprodus local / demonstrat structural / de verificat live); nicio problemă locală prezentată drept compromitere live. Integritate transfer confirmată (1.153 amprente). Servicii live, chei active, facturi furnizori, proba live de 45 min: neobservate — necesită evidențele execuției efective.

### 4.1. P0 — blocante pentru autonomie/producție

- **F01 rute vechi fără auth.** `/api/v1` montat separat; cosemnarea acceptă `recordId+operator` declarat; proba: decizie fictivă reținută + eliberare cu `200` fără token. Risc: eliberări neautorizate, atribuiri false. Expunere condițională dar neexclusă (port publicat, nginx `/api/`→runtime).
- **F02 politica nu constrânge tipul efectiv.** `evaluateOpenHandsEffects` caută șiruri, aprobă dacă găsește o acțiune permisă; fără corespondență read→citire / edit→scriere. Probe: cu doar `read_repo` aprobate scriere/comitere/ștergere via Python; `git push` refuzat (control pozitiv). Defect semantic, nu de regex.
- **F03 agentul împarte domeniul cu serverul de control.** Același container/user `10001`, secrete de sesiune/modele/server accesibile configurațional; `cat /run/secrets/fixture_token` permis textual; rețele `automation-control`+`model-egress`.
- **F04 testele împart accesul cu producătorul dovezilor.** `/artifacts` rw + secret de serviciu, fără user/namespace separat; proba: copilul scrie marker și citește fișier fictiv. Hash-urile detectează modificări ulterioare, nu izolează producătorul inițial.
- **F05 dovada poate preceda ultima modificare.** Sarcina finală doar `commit_local`; `runTests=false` pe final (proba de orchestrare). Nicio legătură obligatorie raport→hash arbore final→încercare→politică teste. F02 agravează: sarcina de comitere poate edita fișiere.
- **F06 evaluatorul nu primește cerința.** `mission_id+claims+materials`, fără `objective`/criterii/politică teste/căi; commit-ul LangGraph omite obiectivul. Victoria validează semnătura, nu înțelege cerința.
- **F09 blocarea e pe execuție, nu pe arbore.** Lease pe `run_id`/`mandate_id`, nu pe calea canonică; două mandate pe același workspace → dublu `acquired`; verificare curățenie trecuta în paralel înainte de scriere.
- **F14 bootstrap reactivează chei revocate.** `upsertApiKey` setează `active=1` la conflict; proba: creare→revocare→`401`→bootstrap→acceptată din nou. Periculos în răspuns la incidente.

### 4.2. P1 — ciclul următor de consolidare / durabilitate

F07 instrucțiunea nesemnată în capabilitate (token+plic valid, text schimbat → `200` la adaptor); F08 reluarea pierde `tests:pass` independent + coliziune `artifact_collision` pe aceeași identitate; F10 bugetul query e filtru estimativ (proba 0,04 vs. 0,24626 USD simulat; `0` nu exclude plătit); F11 rezidența constant `eu`, nederivată din traseu; F12 consens din 2 fragmente ale aceluiași doc + `verifyAndStripCitations` neintegrat; F13 lanțul nu detectează singur trunchierea cozii + `append` netranzacțional + coliziune `canonicalStringify` pe referințe comune; F15 anularea nu omoară `spawnSync` (blochează event-loop); F16 conformanța/CI incomplete (MTA-2b, porți, secrete, audit); F17 reconstrucția nedemonstrată pe gol + verificare `ledger.db` fără `-wal` + versiuni mixte pe servicii; F18 Node 20 EOL.

### 4.3. Ce NU s-a constatat

Nicio compromitere live demonstrată; nicio tranzacție externă/efect fizic în probe; niciun apel comercial în probele de buget; niciun secret real citit. Prioritatea P0 = blocaj, nu dovadă de incident. Scoruri CVSS neacordate (accesibilitate live nemăsurată).

---

## 5. Porțile de consolidare G0–G5 — checklist

> Sursa de lucru: `docs/consolidation/G0-G5-porti-acceptare.md` (PR #42). Fiecare poartă se închide doar cu rezultate observabile. Proprietăți, nu șiruri: `după X nu există Y`.

- **G0 expunere/acces (F01,F14):** matrice fără token → `401/403` pe app + prin proxy; identitate din cheie; revocare→restart tot `401`; inventar rute versionat + test anti-regresie.
- **G1 separarea executorului (F02,F03,F04,F09):** cu `read_repo` zero scrieri (orice formă); sandbox fără secrete/control-plane (probe cu fixture-uri fictive); teste fără `/artifacts`/secrete (doar supervisorul semnează); concurență pe aceeași cale → una admisă.
- **G2 contract/rezultat (F05,F06,F07):** octet post-teste invalidează receipt-ul; evaluator cu `objective` din controller + mutații off-objective respinse; plic canonic semnat complet.
- **G3 reluare/anulare (F08,F15):** întreruperi după execuție/teste/pre-acceptare fără pierderi/costuri inventate, directoare per încercare; kill real al grupului în interval definit + raport `interrupted`.
- **G4 buget/cunoaștere (F10,F11,F12):** același registru de rezervări pentru toate apelurile; `0` = doar gratuit sau refuz; traseu per-etapă + MI9 pe modelul efectiv; 2 fragmente același doc ≠ consens; citare inventată respinsă.
- **G5 livrare/recuperare (F13,F16,F17,F18):** ancoră externă + `append` tranzacțional + JSON strict; CI obligatoriu (Jest complet + CLI + negative securitate + secrete fără bypass) legat de commit/lockfile/digest/politică; manifest rezolvat + restaurare pe gol cu RPO/RTO măsurați; LTS + digest-uri.

Owneri pe componente: API+identitate, platformă execuție, verificare, contabilitate, operațiuni. Fără patch-uri oarbe de teste.

---

## 6. Proba minimală 45 min / 5 USD — mandat și pachet de acceptare

> Sursa de lucru: `docs/consolidation/proba-45min-mandat-pachet.md` (PR #42). O singură sarcină mică, verificabilă, fără efecte externe. Nu moștenește plafonul de 100 USD al controllerului.

**Mandat:** `proba-2026-09-16-001` — obiectiv `sumEvenSquares(n)`, `n=10→120`, în `/work/proba-001` (checkout propriu), acțiuni `[read_repo, edit_worktree, run_tests, commit_local]`, deny restul, 45 min, 5,00 USD agregat real, 1 fix-cycle, allowlist teste, expirare explicită, cheie arhitect. Constrângeri: fără token în sandbox, fără `/artifacts` vizibil, instrucțiune semnată, snapshot→teste→commit exact, evaluator cu obiectiv.

**Plan:** read → edit local → run_tests (supervisor separat) → commit_local îngust. Orice modificare post-teste = ciclu nou.

**Buget:** rezervare înainte de apel (microdolari, IMMEDIATE); retry-urile consumă aceeași rezervă; raportare separată estimat/rezervat/raportat-furnizor/factură.

**Pachet de acceptare (12 piese, obligatoriu):** obiectiv aprobat; mandat semnat+fingerprint; plan+hash; hash inițial/final; comitere (serviciu îngust); log comenzi (argv/cwd/timeout/exit/stdout); raport teste semnat de supervisor (attempt+politică+hash); rezervări+reconciliere; decizii evaluatori (input cu obiectiv + Victoria + legătura mandat→încercare→versiune→receipt); jurnal audit + ancoră externă; raport ADMIS/RESPINS. ADMIS cere: `120`, hash testat = hash comis, cost ≤ 5 USD, timp ≤ 45 min, zero încălcări G0–G2, obiectiv la evaluator, Victoria legat. Captura `complete` nu înlocuiește pachetul.

---

## 7. Operatorul Automatizat Autonom — schelet Tranșa 1 și drum complet

> Sursa de lucru: `src/runtime/operator/` + `tests/operator/` + `docs/consolidation/operator-schelet.md` (PR #43). Stare: poartă fără execuție — evaluează și blochează, nu acționează.

### 7.1. Ce s-a implementat (20 teste verzi, `tsc` curat, legacy adiacent 43/43 verde)

| Piesă | Conținut | Acoperă |
|---|---|---|
| `actions.ts` | 7 tipuri (`ops.observe/repo.read/repo.edit/tests.run/vcs.commit_local/ops.actuate/notify.send`), validare args, modele interzise (secrete, rețea, `python -c`, `git push`, `rm -rf`, evadare) | G1.1/F02 |
| `resource-lease.ts` | Lease pe resursă canonică, o deținere odată, release de deținător, expirare; în memorie, determinist | G1.4/F09 |
| `loop.ts` | `runOperatorTick`: mandat → buget → lease → acțiune tipizată → aprobare (`ops.actuate` cere `approved=true`); fără I/O | G1+G2 |
| Teste | G1.1 (11 negative + tip necunoscut + 1 care documentează golul vechi: stratul text APROBĂ `python -c` cu `read_repo`), G1.4 (exclusivitate/release/expirare), loop (buget/resursă/expirare/aprobare) | — |

Utilizare: `runOperatorTick({mandate, objective, workspaceRoot, branch, resource, owner, action, allowedOperatorTypes, approved, costSoFarUsd, leaseManager, now})` → `ready_to_execute` sau `blocked:<motiv>`.

### 7.2. Ce rămâne (Tranșa 2–3, intenționat neimplementat)

Sandbox real + supervisor semnatar, kill pe grup (F15), capabilitate pe plic complet (F07), snapshot→teste→commit legat (F05), obiectiv în evaluator (F06), lease persistent tranzacțional, percepție L0 reală (demontarea căii simulate), actuatoare cu `dry_run`+compensare, circuit-breaker + frâne/safe-states/time-floors (Cap. 31), red-team + exit drill, `verified_confidence` conectat (L7). Regulă: niciun `ops.actuate` real până la G1–G2 verzi; selecția autonomă de tool-uri rămâne în spatele MI9.

---

## 8. Registrul de afirmații și limbajul public permis

> Sursa de lucru: `docs/consolidation/claims-register.md` (PR #42). Statut inițial la 16.09.2026:

| Afirmație | Statut |
|---|---|
| runtime-ul nu suprimă material performanța | provizoriu — interzis în marketing până la benchmark terț |
| shared-gain cu economii atribuibile (energie) | contestat-în-ameliorare; fee amânat pe trimestrul disputat |
| exit în 30 zile fără pierdere de memorie | parțial; cifra doar cu nota de defect |
| toate testele trec (sept 2026) | **infirmat** pentru arhiva auditată (1.420/1.422) |
| suveranitate verificată per apel | **nedemonstrat** (rezidență constantă) |

**Permis azi:** „prototip avansat cu guvernanță implementată, suită amplă de teste, plan concret de consolidare; două straturi livrate integral + trei subsisteme serioase; 1.420/1.422 + 16 CLI verzi".
**Interzis până la porți verzi:** „autonomie sigură certificată; profit/venit realizat BESS; suveranitate demonstrată per apel; recuperare integral probată; toate testele trec". Retragerea se face cel puțin la fel de tare ca afirmația inițială.

---

## 9. Roadmap și decizii

1. **Decizia 1 — fuzionează PR #42 și #43?** Ambele sunt aditive (docs + schelet fără execuție), CI verde pe ramuri. Recomandat: revizie umană + fuziune umană (regula permanentă: butonul îl apasă omul), apoi măsurători pe `main`.
2. **Decizia 2 — următoarea probă RONOR:** o singură sarcină §6 cu pachet complet, nu o nouă funcționalitate. Succesul = pachet ADMIS + porți atinse, nu anunț.
3. **Decizia 3 — roadmap vs. realitate:** rescrie roadmap-ul să recunoască ce s-a construit (inclusiv `src/runtime` de 13k linii sub alte nume) sau întoarcere la coada P0 pentru termenele 30.09/30.11.2026. Ce nu mai e legitim: două versiuni ale adevărului (plan vs. repo).
4. **Decizia 4 — Tranșa 2 operator:** sandbox + capabilitate completă + lease persistent + un singur actuatoare reversibil cu aprobare, înainte de orice extindere de permisiuni.

---

## Anexa A — Glosar

- **RSIOR** — RONOR Sovereign Intelligence Operating Runtime (nume oficial). **RONOR Orchestrator** — nume scurt.
- **Generative Runtime** — funcțiunea doctrinară de generare guvernată (cartea). **Operating Runtime** — sistemul întreg.
- **MI9** — poarta de guvernanță (6 porți). **Victoria** — autoritate deterministă de acceptare (semnătură + consistență, nu revizie semantică). **Codex-verifier** — rol de cod, model configurabil, nu dovadă de identitate model.
- **P0/P1/P2** — blocaj pre-autonomie / ciclul următor / durabilitate. **G0–G5** — porțile de închidere din §5.
- **Lease** — vechi: pe `run_id`; nou (operator): pe resursă. **Receipt** — legătura mandat→încercare→versiune→rezultat. **Ancoră externă** — cap+lungime lanț într-un registru separat anti-rescriere. **RPO/RTO** — pierdere maximă de date / timp maxim de recuperare, măsurate prin probă.
- **CIDA** — Compliance, Intelligence, Due Diligence & Advisory (metoda de raportare).

## Anexa B — Referințe și trasabilitate

- Doctrină: `The_New_Renaissance_Expanded_Canonical_Edition_v3_0_d139.pdf` (v3.0, aug 2026); aparat: Cap. 21 (12 propoziții), 22 (8 obiecții), 23 (falsifiabilitate + registru), 24 (3 scenarii + zile din 2040), 25–26, lexicon, agenda WS1–8, concordanță.
- Audit: `RONOR_Audit_Aprofundat_2026-09-09_8e4f.pdf` (18 pg, F01–F18, 24 probe, jurnale `full-jest.json/log`, `probes.json`).
- Repo: `src/runtime/automation/{effect-policy,capability,run-lease,test-executor}.ts`, `services/{openhands-bridge,codex-evaluator,evidence-runner}.ts`, `router/{policy,exchange}.ts`, `api/{auth,governance-bridge}.ts`, `knowledge/bridge.ts`, `knowledge/rag.ts`, `audit/hash-chain.ts`, `mission/store.ts`, `agents/{registry,workers}.ts`; `src/runtime/operator/` (nou); `documente/rapoarte/RONOR-stadiu-real-25aug2026.md` (§0 nomenclatură, §3 straturi, §4 gol corectat); `documente/jurnal-decizii.md` (porți deschise, reguli permanente).
- CI/config: `.github/workflows/ci.yml`, `jest.config.js`, `Dockerfile*`, `docker-compose*.yml`, `deploy/nginx/ronor.conf`, `scripts/install-development-runtime-window.sh`.

## Anexa C — Istoricul versiunilor acestui document

| Versiune | Dată | Conținut |
|---|---|---|
| 1.0 | 16.09.2026 | Ediția inițială de export: rezumat, analiză doctrină, arhitectură, F01–F18, G0–G5, probă 45 min/5 USD, operator Tranșa 1, claims register, roadmap. Bazat pe `main@a857989` + PR #42/#43 nefusionate. |

*Sfârșitul documentului de export v1.0 — 16.09.2026.*
