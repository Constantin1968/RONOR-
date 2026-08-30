# Specificație — oglindirea lanțului de audit în baza de guvernanță suverană

## Problema dovedită
`src/persistence/memory-manager.ts` și `src/persistence/supabase-adapter.ts` sunt **cod mort**: zero apeluri
în afara stratului, atât în sursă cât și în imaginea compilată care rulează (`dist/`). Consecință: tabelul
`ronor.audit_events` din baza de guvernanță are zero rânduri, în timp ce lanțul local de amprente
(`/data/ronor.db`, tabelul `audit_chain`) are 19 verigi reale. Serviciul raportează `healthy` fără să verifice
nimic din asta — verde fals.

## Infrastructura existentă (deja în funcțiune, nu se modifică prin acest cod)
Interfață de date suverană peste `ronor-gov-postgres`, containerele `ronor-gov-postgrest` (PostgREST 12.2.3)
și `ronor-gov-datalayer` (nginx, rescrie `/rest/v1/` → rădăcina interfeței), pe rețelele `ronor-governance`
și `ronor-planes`. Serviciul de guvernanță are deja:
- `SUPABASE_URL=http://ronor-gov-datalayer:8080`
- `SUPABASE_SCHEMA=ronor`
- `SUPABASE_SERVICE_ROLE_KEY` = jeton HS256 cu revendicarea `role=service_role`
- `PERSISTENCE_REQUIRED=false`
Calea de scriere e probată: POST → HTTP 201, citire → 200, anonim → 401.

## Ce trebuie implementat

### 1. Modul nou: `src/persistence/audit-mirror.ts`
Oglindește fiecare verigă din lanțul local în `ronor.audit_events`, prin `MemoryManager.recordAuditEvent`.
Reguli obligatorii:
- **Lanțul local rămâne autoritar.** Oglindirea nu blochează și nu aruncă niciodată în calea `append()`.
- Asincron, fără așteptare: `void oglindeste(record).catch(...)`, cu jurnalizare la eșec.
- Când `PERSISTENCE_REQUIRED=true`, un eșec de oglindire se jurnalizează la nivel `error` și incrementează
  un contor de degradare expus prin sănătate. Nu refuză cererea — refuzul aparține stratului de cerere, nu
  celui de audit.
- Contorizează în memorie: `oglindite`, `esuate`, `ultimul_seq_oglindit`, `ultima_eroare`, `ultima_reusita_la`.

### 2. Traducerea tipului de decizie în vocabularul constrâns
Constrângerea `audit_events_event_type_check` admite **exclusiv**:
`query`, `mission_dispatch`, `cosign_requested`, `cosign_approved`, `cosign_rejected`, `cosign_expired`,
`governance_block`, `knowledge_ingest`, `agent_dispatch`, `system_boot`, `system_shutdown`.
Orice altă valoare produce HTTP 403/400 și pierderea rândului. Traducere:

| `decision_type` din lanțul local | `event_type` |
|---|---|
| `runtime.query.*` | `query` |
| `governance.appeal.opened` | `cosign_requested` |
| `governance.appeal.approved` | `cosign_approved` |
| `governance.appeal.rejected` | `cosign_rejected` |
| `governance.appeal.expired` | `cosign_expired` |
| `governance.block*`, verdict `deny` | `governance_block` |
| `mission.*` | `mission_dispatch` |
| `agent.*`, `runtime.agents.dispatch` | `agent_dispatch` |
| `knowledge.*` | `knowledge_ingest` |
| `system.boot` | `system_boot` |
| `system.shutdown` | `system_shutdown` |
| orice altceva | `query`, cu tipul original păstrat în `payload_json.decision_type_original` |

Funcția de traducere trebuie **exportată** și acoperită de teste.

### 3. Câmpuri de completat la fiecare oglindire
- `audit_chain_hash` = `chain_hash` al verigii. Migrația spune explicit: „SHA-256 from the runtime SQLite
  audit chain. Reconciliation key." Acesta e rostul câmpului — permite reconcilierea celor două registre.
- `request_id` = `decision_id`; `verdict` = verdictul porții; `occurred_at` = marca de timp a verigii;
  `human_cosign_required` = adevărat când verdictul e `escalate` sau `deny`;
- `model_id`, `latency_ms`, `cost_usd` din sarcina utilă a verigii, când există;
- `payload_json` = sarcina utilă a verigii plus `seq`, `record_id`, `prev_hash`.

### 4. Legarea în `src/audit/hash-chain.ts`
În `append()`, imediat după inserarea locală reușită și înainte de `return record`, se cheamă oglindirea.
`append()` rămâne sincron; oglindirea pornește și nu se așteaptă.

### 5. Sănătate onestă — eliminarea verdelui fals
Sănătatea trebuie să raporteze starea reală a persistenței relaționale: `configurat`, `accesibil`,
`ultimul_seq_oglindit`, `verigi_neoglindite` (diferența față de `seq` maxim local), `ultima_eroare`.
Regula: dacă persistența e configurată dar inaccesibilă, starea generală devine `degraded`, nu `healthy`.
Dacă nu e configurată deloc, starea e `degraded` cu motiv explicit. Se modifică ambele căi de sănătate
(`/health` și `/api/runtime/health`), plus verificarea de sănătate a containerului dacă e nevoie.

### 6. Teste (Jest)
- traducerea fiecărui tip din tabel, inclusiv cazul implicit;
- un eșec de oglindire nu aruncă din `append()` și nu strică lanțul;
- `audit_chain_hash` transmis e identic cu `chain_hash` al verigii;
- sănătatea devine `degraded` când persistența e configurată dar inaccesibilă;
- `human_cosign_required` adevărat pentru `escalate` și `deny`.

## Constrângeri de proces — obligatorii
- **Fără merge, fără push pe `main`, fără release, fără deploy.** Ramură nouă + cerere de integrare.
- Ramura: `feat/oglindire-audit-in-baza-suverana`.
- Nu se pornesc, opresc sau recreează containere. Nu se rulează migrații.
- Nu se afișează niciodată valori de secrete.
- Depozitul: `Constantin1968/RONOR-` (numele se termină cu cratimă), clona `/home/user/workspace/ronor`.
- Cele șase verificări obligatorii trebuie să treacă: TypeScript Build, Security Scan, Jest Tests,
  R-Knowledge Conformance, Baseline Equivalence (R-Knowledge disabled), Automation Activation Preflight
  Contract. Verifică-le cu `gh` după deschiderea cererii și repară ce cade.
- Mesaje de comitere și descrierea cererii **în română cu diacritice complete**.
