# Ronor SIS — Arhitectura canonică

**Pregătit de:** NrgPaths Advisory Ltd
**Data:** 3 octombrie 2026 · **Versiunea:** 1 · **Stare:** propusă spre acceptare
**Bază de verificare:** depozitul `Constantin1968/RONOR-`, ramura principală, comitul `a09ee52`
**Natură:** document normativ intern. După acceptare, devine autoritatea pentru arhitectura produsului și înlocuiește, ca autoritate, „RONOR / RSIOR — Arhitectura canonică” (verificată la `9e4f315`). Documentul anterior se păstrează nemodificat, ca istoric.

---

## 1. Decizia constituțională

**Ronor SIS — Sovereign Intelligence System este produsul central al Ma11AI.**

Ronor SIS este un sistem integrat pentru guvernanța, inteligența și managementul operațional al entităților private și publice. Fiecare instalare este configurată după misiunea, mandatul și cadrul legal al organizației deservite.

Ma11AI construiește Ronor ca sistem, nu ca aplicație SaaS. XaaS descrie modul de furnizare a serviciului integrat, nu identitatea produsului.

Formula de produs:

> Ma11AI dezvoltă Ronor. Utilizatorul și organizația lucrează cu Ronor. Ronor mobilizează Arms și capabilități native pentru rezultate verificabile și, în limitele autorizate, pentru acțiune.

Arhitectura este **definită**, iar etapa următoare este **deployment-ul**. Starea fiecărei componente instalate se declară separat, pe module, cu cale de fișier și dovadă (secțiunea 9).

## 2. Nomenclatura canonică

### 2.1 Denumiri

| Termen | Înțeles canonic |
|---|---|
| **Ma11AI** | Compania care deține, dezvoltă și comercializează Ronor |
| **Ronor SIS** sau **Ronor** | Produsul întreg: experiența, inteligența nativă, Arms, Runtime și operarea tehnică |
| **Ronor Runtime** | Subsistemul de coordonare și execuție: misiuni, agenți, instrumente, Registry, Ledger, planuri de runtime. Denumit anterior RSIOR, Sovereign Intelligence Operating Runtime |
| **Ronor Arms** | Extensiile funcționale și de domeniu ale aceluiași produs |
| **R-PowerTrade** | Arm-ul de energie și operațiuni de piață; numele nu implică autorizația de a tranzacționa |
| **Vakyn** | Capabilitatea nativă de clasificare, specializare și antrenare a modelelor, provenită din achiziția Ma11AI |
| **JEKYO** | Stratul nativ de operare tehnică: instalare, găzduire, monitorizare, versiuni, revenire, backup și restaurare, provenit din achiziția Ma11AI |
| **CIDA** | Central Intelligence Data Architecture: sistemul distinct de date, dovezi și memorie |
| **Continuumpedia** | Sistemul distinct de cunoaștere vie și cercetare, cu cele opt motoare canonice |
| **MI9**, **R-Sentinel** | Mecanismele de asigurare; nu sunt subordonate componentei pe care o constrâng |

### 2.2 Grafia

1. În tot textul de marcă se scrie **„Ronor”**: documente vii, interfețe, mesaje, bannere, prompturi de sistem și site-uri.
2. Identificatorii tehnici rămân neschimbați, deoarece sunt contracte între servicii, gazde și rețete:
   - variabilele de mediu `RONOR_*`;
   - antetele `X-RONOR-*`;
   - delimitatorii `RONOR-DATA`;
   - identificatorii cu minuscule (`ronor-*`, `/srv/ronor`, `ronor.tech`);
   - numele depozitului.
3. Arhivele, dovezile și rapoartele datate rămân în forma de la data lor.
4. **RSIOR** nu mai desemnează produsul. Apare o singură dată, ca denumire anterioară a Ronor Runtime.

### 2.3 Reguli moștenite, păstrate

Rămân în vigoare regulile din canonul anterior (secțiunea 2):

- **`L0–L7`** desemnează exclusiv straturile de ambiție din Strategic Brief.
- Starea codului se exprimă pe module, nu pe straturi.
- **„Plan” (`plane`)** desemnează exclusiv un director din `src/planes/`, iar numărul lor se dă împreună cu criteriul folosit.
- **`E1–E8`** desemnează entitățile de ecosistem.
- Serviciile Python `r-*` sunt servicii de infrastructură, nu planuri.

## 3. Harta produsului

```text
Ma11AI
└── Ronor SIS — produsul central
    ├── Experiența unificată
    │   ├── spații de lucru, proiecte, misiuni, rezultate, aprobări
    │   └── suprafețe: consola web, interfața programatică, Telegram, voce
    ├── Ronor Arms
    │   ├── funcționale: cercetare și analiză, dezvoltare software și inginerie
    │   └── de domeniu: energie și stocare, R-PowerTrade, operațiuni organizaționale,
    │                   industrie și sisteme fizice, administrație publică
    ├── Capabilități native de inteligență
    │   ├── Vakyn: clasificare, specializare, antrenare
    │   └── alte modele, algoritmi deterministici și instrumente admise
    ├── Ronor Runtime
    │   ├── planuri de runtime, orchestrare, misiuni, agenți, instrumente
    │   ├── Registry: identitate, mandate, autoritate
    │   └── Ledger: stări, decizii, costuri, evidența operațională
    └── JEKYO: stratul comun de operare tehnică
        ├── configurații și pachete de instalare
        ├── medii de test și de operare
        ├── găzduirea serviciilor și a modelelor
        ├── jurnale, stare și indicatori tehnici
        └── revizii, backup și restaurare

CIDA ↔ Ronor               contracte controlate pentru date, dovezi și memorie
Continuumpedia ↔ Ronor     contracte controlate pentru cunoaștere și cercetare
Asigurare independentă      MI9, R-Sentinel, verificatorul independent, autoritatea umană
                            → constrâng operațiile; nu sunt controlate de componenta evaluată
```

Comercial, Ronor este produsul întreg. Tehnic, Ronor Runtime este un subsistem, iar CIDA și Continuumpedia rămân sisteme distincte care îl alimentează. Identitatea comună a produsului nu elimină separarea tehnică a funcțiilor și nici izolarea dintre clienți, proiecte, entități juridice și mandate.

## 4. Subsistemele și granițele lor

| Subsistem | Responsabilitate | Ce nu face |
|---|---|---|
| Experiența unificată | Traduce intenția utilizatorului într-o misiune cu domeniu, mod de lucru și autoritate explicite; arată ce rulează, ce este propus, ce este verificat și ce a produs efect | Nu acordă autoritate și nu ascunde costul sau excepțiile |
| Ronor Arms | Compun modele, reguli, instrumente, dovezi și constrângeri într-un flux complet de domeniu | Nu își extind singure mandatul; delegarea nu lărgește drepturile |
| Vakyn | Execută versiunea admisă a clasificatorului; produce candidați de model din date eligibile | Nu primește credențiale de execuție; nu își promovează singur candidații; rezultatul este o contribuție la decizie, nu o autorizație |
| Ronor Runtime | Coordonează misiunile, aplică admiterea înainte de efect, execută prin instrumente cu acces limitat, consemnează în Ledger | Nu se evaluează singur; un succes intern nu este dovada efectului |
| JEKYO | Instalează, găzduiește, observă, versionează, revine și restaurează serviciile admise | Nu decide semantica misiunii sau autoritatea; nu primește acces general din partea agentului care produce codul |
| CIDA | Păstrează proveniența, dovezile, contradicțiile și memoria guvernată | Nu este un volum oarecare; o copie nu înseamnă recuperarea cunoașterii |
| Continuumpedia | Transformă informația în cunoaștere revizuibilă prin cele opt motoare | Actualizarea cunoașterii nu este reantrenarea unui model |
| Asigurarea independentă | Verifică, blochează și acceptă din afara componentei evaluate | Nu este „plan” al runtime-ului; denumirea nu constituie independență |

## 5. Contractele canonice

Contractele de mai jos sunt normative. Implementarea lor în cod constituie poarta D din planul de reconstrucție.

### 5.1 Contractul unui Arm

Fiecare Arm are un **manifest versionat**, validat la încărcare. Manifestul precizează:

| Câmp | Conținut |
|---|---|
| Scop | utilizatorii, problemele acceptate, situațiile excluse |
| Date | scheme, surse, prospețime, confidențialitate, drepturi, izolare |
| Capabilități | versiunile admise de modele, instrumente și algoritmi |
| Autoritate | acțiunile permise, țintele, aprobările, expirarea, revocarea |
| Comportament degradat | ce se întâmplă la lipsa datelor, expirarea termenului, indisponibilitatea unui motor sau retragerea mandatului |
| Evaluare | seturi de test, comparator, criterii de acceptare, limite cunoscute |
| Operare | observabilitate, costuri, recuperare, responsabilul tehnic |

Regula de delegare: când un Arm deleagă altui Arm, drepturile primite nu depășesc intersecția dintre mandatul misiunii și drepturile destinatarului.

### 5.2 Contractul de inferență pentru clasificare

| Parte | Câmpuri |
|---|---|
| Intrare | cererea, misiunea, clientul și proiectul, Arm-ul, sarcina, schema și datele, momentul observației, versiunea de model admisă, termenul-limită, politica aplicabilă |
| Ieșire | starea procesării, rezultatul în schema permisă, versiunea modelului și a preprocesării, durata măsurată, avertismentele, legătura cu jurnalul |
| Incertitudine | probabilități numai dacă sunt disponibile și evaluate; abținere numai printr-un mecanism definit și testat |
| Erori distincte | date invalide, date expirate, model neadmis, termen depășit, serviciu indisponibil |

Un număr produs de model nu se numește automat probabilitate calibrată. Conținutul unui răspuns de model nu poate modifica lista acțiunilor permise, bugetul sau destinatarul unei comenzi.

### 5.3 Contractul de operații tehnice

Ronor transmite stratului de operare o cerere structurată, nu o comandă liberă:

- **Cerere:** identificator unic, operația admisă, ținta exactă, revizia sau artefactul, condițiile inițiale, autorizația și expirarea.
- **Aplicare:** executorul verifică drepturile și revocarea înainte de efect, apoi invocă doar operația permisă.
- **Răspuns:** stare explicită, versiunea efectivă, identificatorul operației, dovezi fără secrete.
- **Reconciliere:** Ledger leagă cererea de rezultat. Pierderea răspunsului nu justifică repetarea oarbă a unei operații cu efect.
- **Clase de risc distincte:** citire, repornire, instalare, restaurare, retragere.

### 5.4 Contractele cu CIDA și Continuumpedia

Ronor citește și scrie în CIDA și Continuumpedia numai prin contracte controlate. Contractele precizează:
- ce operații trec prin poarta MI9;
- ce se observă după execuție;
- care este calea de oprire.

Vakyn poate propune clasificări în lanțul canonic **Sursă → Dovadă → Afirmație → Cunoaștere → Ipoteză → Insight → Scenariu → Decizie → Acțiune → Rezultat → Învățare**. Promovarea între stările de încredere rămâne supusă regulilor și dovezilor, nu scorului unui clasificator.

## 6. Fluxul operațional canonic

1. Ronor identifică obiectivul, proiectul și Arm-ul relevant. Cere clarificări numai pentru informații care schimbă material acțiunea.
2. Registry admite misiunea, accesul la date și consumul de resurse înaintea operațiilor relevante.
3. Contextul permis este extras și verificat. Instrucțiunile găsite în documente nu devin autoritate.
4. Arm-ul compune capabilitățile: clasificare nativă, raționament, reguli, prognoză sau optimizare.
5. Rezultatul este verificat față de constrângeri, obligații și condițiile mandatului.
6. Acțiunile care cer aprobare rămân în așteptare. Acțiunile permise se execută prin instrumente cu acces limitat, **după** poarta de admitere, niciodată înaintea ei.
7. Efectul este reconciliat cu sistemul extern. Trimiterea unei comenzi nu echivalează cu reușita ei.
8. Utilizatorul primește rezultatul, dovezile, costul și excepțiile. Ledger păstrează traseul.

STOP blochează acțiunile încă neexecutate și duce operația în starea prevăzută de procedura domeniului. Nu promite anularea unui efect deja produs.

Pentru efectele fizice, buclele rapide și protecțiile echipamentului nu depind de o conversație sau de un model general.

## 7. Bucla de învățare

```text
Surse și observații eligibile
  → dovezi și cunoaștere (CIDA / Continuumpedia)
  → set de date și obiectiv de experiment
  → candidat de model (Vakyn, mediu izolat prin JEKYO)
  → evaluare independentă
  → acceptare și versiune admisă
  → utilizare într-un Arm
  → rezultat observat și reconciliat
  → corectarea cunoașterii sau un nou experiment
```

Corectarea unui fapt, antrenarea unui candidat, admiterea unei versiuni și autorizarea unei instalări sunt patru acte distincte. Feedbackul este verificat înainte să devină etichetă de antrenare sau fapt consolidat. Nu există promovare automată în producție.

## 8. Invarianți constituționali

| # | Invariant |
|---|---|
| I1 | Autoritatea umană este explicită; un model sau un agent nu își acordă singur autoritatea |
| I2 | Asigurarea rămâne în afara componentei pe care o constrânge |
| I3 | Verificarea identității, a mandatului, a destinației și a revocării se face înainte de efect |
| I4 | Producerea unei modificări, verificarea, aprobarea și instalarea sunt acte distincte |
| I5 | Pregătit, aprobat, executat și acceptat sunt stări distincte |
| I6 | Clienții, mediile, cheile, modelele și lucrările de antrenare au limite explicite |
| I7 | Copia de siguranță, restaurarea și calitatea cunoașterii sunt probe distincte |
| I8 | Deținerea unei tehnologii nu dovedește performanță, superioritate, independență sau caracter FOAK, First-of-a-Kind |
| I9 | Arhitectura definită nu se prezintă drept serviciu activ; starea deployment-ului se declară separat |
| I10 | Contractele sunt neutre față de implementare; Vakyn și JEKYO sunt integrate prin adaptoare înlocuibile |

## 9. Corespondența cu codul la `a09ee52`

| Element canonic | Implementarea actuală | Stare |
|---|---|---|
| Ronor Runtime | `src/runtime/` (104 fișiere), `src/planes/` (12), `src/orchestrator.ts`, `src/governance/` | Implementat ca subsistem; datoriile din secțiunea 10 rămân |
| Asigurare MI9 | `src/governance/mi9-gate.ts`, `mi9-enforcement.ts` | Verdictul se aplică. Dezarmarea prin `MI9_ENFORCE=off` este refuzată în producție, deci datoria 3 din canonul anterior este închisă în cod. |
| R-Sentinel | `src/sentinel/` | Observațional, în afara traseului cererii |
| Arms | `services/r-powertrade/` | Serviciu separat, fără manifest comun |
| Vakyn | — | Contractul este definit; implementarea urmează recepției tehnice |
| JEKYO | Rețete de reconstrucție, Compose, verificarea abaterilor | Contractul este definit; integrarea urmează recepției tehnice |
| Registry și Ledger de produs | Registrele runtime-ului, registrul de buget pentru modele | Necesită identitatea Arm-ului și a capabilității în fiecare operație |
| Descriptorul produsului | — | De construit în `src/sis/` |
| Experiența unificată | Consola web, interfața programatică, Telegram, fiecare separat | De unificat pe același obiect de misiune |

## 10. Datoriile moștenite

Datoriile 1, 2 și 4–10 din canonul anterior rămân în registru, cu aceleași întrebări de proprietate. Starea lor se reverifică în poarta D, înainte de primul Arm integrat.

Datoria 2 are prioritate. Ea privește ordinea dintre poarta MI9 și `R-Execution`, care are acum 81 de linii. Ordinea trebuie corectată înainte ca `R-Execution` să producă efecte reale.

Datoriile noi introduse de prezentul canon:

| # | Datorie | Ce trebuie decis |
|---|---|---|
| 11 | Descriptorul produsului lipsește din cod | Structura `src/sis/` și expunerea read-only a subsistemelor și stărilor lor |
| 12 | Arms fără manifest | Schema manifestului și primul manifest, R-PowerTrade în modul umbră |
| 13 | Recepția tehnică Vakyn | Inventarul activelor predate și rularea reproductibilă |
| 14 | Recepția tehnică JEKYO | Perimetrul transferului, adaptarea la contractul de operații, restrângerea drepturilor |
| 15 | Grafia în textul viu | Lotul de marcă în cod, documente și site, conform secțiunii 2.2 |

## 11. Porțile de implementare

Aceasta este ordinea dependențelor, nu un calendar.

| Poartă | Lucrare | Dovada |
|---|---|---|
| A | Acceptarea prezentului canon | Acceptarea proprietarului |
| B | Regula de grafie | Aprobată pe 3 octombrie 2026 |
| C | Lotul de marcă în cod | Suita completă trece; un test verifică textul viu și neschimbarea identificatorilor tehnici |
| D | Contractele SIS în cod | Probele de refuz: separarea clienților, rezultat expirat, model neadmis, revocare, revenire, eșec de clasificare, delegare între Arms, reproducibilitate |
| E | Site-urile | Verificarea vizuală pe desktop și mobil; publicarea este o decizie separată |
| F | Instalarea | Fiecare gazdă aprobată separat; reconstrucția din rețete și fotografia de referință reîmprospătată |
| G | Recepția Vakyn și JEKYO, legarea de contracte | Un candidat produs din activele predate; o operație JEKYO executată prin contract, cu revenire și restaurare |

## 12. Documente reconciliate

| Document | Statut după acceptare |
|---|---|
| „RONOR / RSIOR — Arhitectura canonică” (`9e4f315`) | Istoric. Regulile sale de nomenclatură și registrul de datorii sunt preluate aici. |
| „RONOR: arhitectura-țintă de produs pentru Ma11AI”, v1 | Încorporat ca normă. Rămâne referința detaliată pentru Arms și Vakyn. |
| „RONOR SIS, Vakyn și JEKYO: matricea rolurilor”, v3 | Încorporat ca normă. Rămâne referința detaliată pentru JEKYO. |
| „Mayleven Ecosystem Canonical Architecture v2” | Izvorul pentru CIDA, Continuumpedia, cele opt motoare și disciplina încrederii; nemodificat |
| Strategic Brief `L0–L7` | Ancorajul ambiției; nemodificat |
| „Ronor SIS — Analiza transformării din RSIOR”, 3 octombrie 2026 | Planul de lucru asociat |

---

*NrgPaths Advisory Ltd · document normativ intern · verificat față de comitul `a09ee52`*
