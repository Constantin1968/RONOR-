# Verificarea automată a unui commit existent

Operațiunea `verify-existing` verifică un interval Git exact, fără planificare sau
rescriere prin OpenHands. Este o operațiune distinctă de dezvoltarea completă:
rezultatul ei este `verified`, nu un run de autor declarat artificial `complete`.

## Condiții de operare

- Controllerul, evidence runner, serviciul de verificare Codex și Victoria trebuie
  să ruleze versiunile compatibile, în rețeaua izolată existentă.
- `RONOR_AUTOMATION_RECOVERY_ENABLED` trebuie să fie `false`. Reluarea automată
  a autorului nu trebuie să ocolească blocarea spațiului în timpul verificării.
- Arborele țintă este cel configurat pe server, curat, pe ramura aprobată.
  Cererea nu poate furniza o cale, o comandă de test sau o adresă de serviciu.
- `RONOR_AUTOMATION_EXPECTED_HEAD` trebuie fixat la commit-ul candidat pentru
  această operațiune, nu confundat cu baza diferenței. `base_commit` este strămoșul
  explicit față de care se verifică diferența, iar `head_commit` este candidatul.
- Sunt necesare identificatoare Git complete de 40 de caractere. Nu se face
  checkout, reset, clean, editare de cod, push, merge, release sau deploy.
- Controllerul și serviciul de teste primesc ținta numai pentru citire.
  Testele rulează în containerul izolat existent, cu politica de comenzi configurată
  de operator. O comandă permisă execută totuși cod din repository: lista de
  comenzi permise nu înlocuiește izolarea sistemului de operare.
- Cheia Architect se citește din fișierul privat indicat de
  `RONOR_DEVELOPMENT_API_KEY_FILE`; nu se pune în cerere sau în istoricul shell.

## Comenzi

Pregătește un fișier JSON cu exact patru câmpuri: `base_commit`, `head_commit`,
`max_cost_usd` și `max_runtime_minutes`. Primele două sunt hash-urile reale complete,
costul este plafonul explicit autorizat, iar durata este un număr întreg pozitiv
de minute, în limitele politicii serverului. Nu introduce câmpul `approved` în
fișier: comanda de pornire exprimă aprobarea operațiunii descrise de el.

```sh
node scripts/ronor-develop.mjs verify-existing \
  --request=/cale/privata/verificare.json --id=verificare-stabila-001
```

Răspunsul inițial conține `verification.verification_id`. Etapele continuă automat
în controller; nu trebuie comandate manual Codex sau Victoria.

```sh
node scripts/ronor-develop.mjs verification-status \
  --verification=verify_IDENTIFICATORUL_COMPLET_RETURNAT

node scripts/ronor-develop.mjs verification-cancel \
  --verification=verify_IDENTIFICATORUL_COMPLET_RETURNAT
```

Identificatorul real începe cu `verify_` și are apoi 64 de caractere hexazecimale.
Exemplele de mai sus nu conțin identificatoare executabile. Repetarea cererii cu
același identificator de idempotență și același conținut recuperează aceeași
operațiune; nu pornește automat încă o verificare plătită.

## Ce dovedește rezultatul

Fluxul verifică identitatea celor trei servicii, arborele curat și diferența
`base..head`, rulează testele permise, verifică integritatea artefactelor și trimite
același pachet către Codex și Victoria. Victoria trebuie să valideze semnătura
receipt-ului și dovezile; un răspuns HTTP nereușit nu poate fi transformat în succes.

Starea persistentă conține hash-urile, digestul dovezilor, receipt-ul, rezultatul
Victoria, limita și costul cunoscut sau `null`. Protecția stării folosește un cod de
autentificare criptografică; aceasta nu trebuie prezentată drept istoric complet al
tuturor tranzițiilor sau drept finalizarea unei misiuni de dezvoltare.

Anularea și întreruperea nu refac arborele și nu generează acceptare. O repornire
nu reia automat o cerere cu rezultat incert. Blocarea temporară a spațiului de
lucru poate rămâne până la expirarea mandatului, pentru a nu suprapune o nouă
execuție peste o cerere îndepărtată încă în curs.

Separat, o cerere normală de pornire a autorului al cărei client se deconectează
înainte de răspuns păstrează bariera de admitere. Poate necesita reconciliere de
operator; nu se presupune că deconectarea clientului a oprit execuția.

## Instalare separată de execuție

Fișierul `docker-compose.development-existing-verification.yml` este un overlay
opțional, aplicabil ultimul peste configurația de dezvoltare deja instalată.
El fixează imaginea și sursa pentru exact trei servicii: `controller`,
`openhands-bridge` și `automation-evidence-runner`. Nu schimbă volumele, cheile,
rețelele, politica de repornire sau serviciile runtime-ului de afaceri.

Operatorul fixează `RONOR_EXISTING_VERIFY_SOURCE` la directorul sursei revizuite,
`RONOR_EXISTING_VERIFY_TAG` la versiunea acesteia și `RONOR_EXISTING_VERIFY_HEAD`
la hash-ul complet al candidatului verificat. Versiunea executabilului de control
și commit-ul țintă sunt identificatoare diferite și nu trebuie confundate.

Instalarea necesită aprobarea sa separată, păstrarea stării existente și absența
execuțiilor active. Nu se rulează automat vreun script de resetare sau curățare
pentru a face arborele să pară curat. Orice arbore murdar se conservă înainte de
o intervenție autorizată, fără pierderea muncii existente.

## Limita validării locale

Testele automate ale acestui cod pot simula transportul și evaluarea modelului.
Ele verifică protocolul, integritatea și refuzurile, dar nu reprezintă o acceptare
live a candidatului de către serviciile instalate pe gazdă. Aceasta se declară
numai după instalarea autorizată și o execuție reală cu rezultat `verified`.
