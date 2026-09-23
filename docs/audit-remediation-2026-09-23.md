# RONOR: registrul remedierilor auditului din 23 septembrie 2026

Stadiu v4: lotul de replicare Hetzner–Contabo și izolarea botului conversațional
pe Hetzner sunt instalate și verificate în limitele descrise mai jos. Restul
candidatului rămâne local, nepublicat și neinstalat. Bază: `a857989`, ramura
integrată citită din GitHub în această sesiune. Solicitarea de reparare integrală
nu este încă îndeplinită. Constatarea F17 are controale remediate, dar nu este
închisă integral. Nici izolarea botului nu echivalează cu închiderea F01 sau cu
acceptarea întregului sistem pentru operare autonomă nesupravegheată.

## Actualizare instalată: izolarea botului

Transferul a avut loc la 23 septembrie 2026, 22:32 British Summer Time (BST,
ora Londrei), respectiv 21:32 Coordinated Universal Time (UTC) și 24 septembrie,
00:32 Eastern European Summer Time (EEST). Verificarea finală este datată
`2026-09-23T21:33:11Z`. Aprobarea explicită a acoperit citirile, conservarea și
recrearea numai a botului, releul auxiliar și verificări fără mesaje de test
sau inferențe plătite. Nu a autorizat rotația cheilor ori schimbarea altor servicii.

- **Bot instalat:** `ronor-orchestrator` rulează cu utilizatorul `10001:10001`,
  rețea `none`, sistem de fișiere principal numai pentru citire, capabilități
  Linux eliminate și `no-new-privileges`. Singura interfață este `lo`.
  Nu are socketul sau binarul Docker, directoarele SSH ori montarea `/opt/ronor`.
- **Releu separat:** `ronor-bot-egress`, utilizator `10002:10001`, fără porturi
  publicate, deservește un socket Unix privat. Permite numai operațiile definite
  pentru Telegram, Qwen, memorie și CIDA, fără redirecționări arbitrare. Botul
  primește aliasuri, nu cheile reale. Acreditările existente sunt într-un fișier
  montat exclusiv în releu, modul 400, fără afișarea valorilor.
- **Conservare:** vechiul container există oprit ca
  `ronor-orchestrator-pre-isolation-20260924`, cu repornire automată dezactivată.
  Configurația și sursa inițiale sunt păstrate privat pe gazdă. Nu există revenire
  automată la varianta privilegiată. Intrarea declarativă veche a fost înlocuită
  cu configurația izolată pentru a nu recrea accidental vechile privilegii.
- **Recepție și stare:** SQLite persistă recepția înaintea confirmării Telegram.
  Sarcinile incerte sunt `interrupted`, fără reluare automată. La transfer au
  fost găsite zero mesaje neconfirmate. Această observație nu dovedește retroactiv
  că vechiul bot nu a pierdut mesaje înaintea intervenției. Memoria externă nu
  a fost ștearsă sau migrată; istoricul volatil al vechiului proces nu a fost exportat.
- **Verificare:** botul și releul au starea Docker `healthy`; recepția Telegram
  produce heartbeat. Probele sigure Telegram și `/health` pentru memorie/CIDA
  întorc 200. Accesul la Docker, administrarea CIDA și destinații arbitrare este
  refuzat cu 403; conexiunile TCP directe sunt refuzate. Scrierea în `/app` este
  refuzată cu `EROFS`. Cele șapte regresii de izolare trec în imaginea instalată.
- **Servicii păstrate:** identificatorii și momentele pornirii pentru `cida-api`
  și `ronor-r-memory` sunt neschimbate. Nu au fost repornite și nu s-au modificat
  cheile, firewallul, runtime-urile generale sau pragurile de acceptare.

### Defect CIDA constatat, nu ascuns

Botul vechi folosea `/query`, dar serviciul instalat expune `/search`.
Candidatul folosește acum căutarea lexicală `/search`, cu limită explicită.
Proba autorizată a returnat 401: cheia root existentă în configurația CIDA are
în registrul serviciului `enabled=false`. Nu a fost reactivată și nu a fost
copiată în releu. În lipsa unei chei autorizate numai pentru citire, releul refuză
local căutarea cu 403. Disponibilitatea `/health` nu este căutare funcțională.

### Identitatea codului instalat

Codul imaginii provine din revizia locală `6b3426617f1e5b46e4be0fc978412809f0b753f2`.
Configurația Compose corectată și scripturile de transfer sunt în `a9e40cd`.
Imaginea instalată este fixată prin
`sha256:d969a6442df9205c71815c0f49a24762d95c0e01093ea5a9d584c9badc36d9c0`.
Imaginea de bază Python și versiunile pachetelor sunt fixate; descărcările pip
nu au încă un fișier de blocare cu amprentele fiecărui pachet.

| Obiect instalat | SHA-256 |
|---|---|
| `main.py` | `14daca2484928dd3f994b8f74e2b369f6f08c1fb9457fcf8229e4f1e7a0c5db5` |
| `isolation_proxy.py` | `a8ea9747af496860f9a829e23fb50d8e2f5551ce53fb502f7cbc561a6bd6e307` |
| `relay_transport.py` | `8c344fbf755523b92cdb1ea6ab8e2a564586551ae18147977b7cdd012153a71b` |
| `task_inbox.py` | `4614cca9bc83b3f8936710e9cd7988db0173817eaecd2402825525aee9cdafb6` |
| Compose instalat, inclusiv intrarea declarativă veche | `a8fb45ce62e204acf5f6e65b5b235499ccfabb6faafdf0cf604f6de8c62d93a6` |

### Limitele acceptării acestui lot

Nu s-a trimis mesaj de test, nu s-a făcut inferență plătită și nu s-a scris o
amintire sintetică în producție. Prin urmare, nu se pretinde acceptare integrală
a unui traseu conversație–model–memorie–răspuns. STOP și căderea procesului sunt
probate cu dubluri de servicii, inclusiv în imaginea exactă; nu anulează cereri
deja acceptate în afara botului. Nu s-a repornit gazda.

Cheile istorice nu sunt revocate. Releul deține încă acreditări externe și este
o componentă sensibilă; nu are un plafon financiar agregat. Rutinele istorice
neexpuse rămân în sursă, fără acces la resursele administrative ale gazdei.
Directorul nou `/opt/ronor-bot-isolated`, inclusiv SQLite și fișierul de secrete,
necesită integrare explicită în backupul de producție și probă de restaurare.
Arhivarea codului în proiect nu substituie backupul stării operaționale.

## Lucrări efectuate

- Cod de refuz înainte de inferență, independent de metadatele furnizate de client.
  Lipsa autorității, ruta diferită, expirarea, refuzul politicii sau eșecul scrierii
  în audit opresc fluxul înainte de model. Admiterea nu este numită execuție.
- Planul de execuție refuză apelurile când nu există executor autorizat. Nu mai
  inventează execuții și nu mai declară sănătos un executor absent.
- Botul auditat este adus în copia de lucru fără credențialele redactate și fără
  valori implicite de autentificare. Modelul nu poate apela shell, acces de la
  distanță, e-mail, pagini web arbitrare sau agenți externi.
- Recepție persistentă, eliminarea duplicatelor după identificatorul Telegram,
  lucru asincron și STOP. După căderea procesului, o operațiune cu rezultat
  incert este marcată întreruptă și nu este reexecutată automat.
- Citirea memoriei nu șterge eroarea scrierii. Memoria regăsită păstrează
  identificatorul, scorul și metadatele, cu rol de date, nu de sistem.
- Istoricul nu mai dublează mesajul curent și reține răspunsul final.
- Rezultate structurate pentru comenzile de diagnostic și confirmare explicită
  a livrării Telegram; eșecurile nu mai sunt raportate ca succes.
- Raportarea nu mai trunchiază lista serviciilor fără repornire. Porturile sunt
  distincte; adresele private nu sunt numărate ca publice. Ascultarea unui port
  nu este confundată cu accesibilitatea prin firewall.
- Inventarul surselor separă înregistrarea, productivitatea istorică și acoperirea
  recentă demonstrată. Sursele de test sunt separate. În absența datelor unice
  pe fereastră și a probei de proveniență, acoperirea este „nedemonstrată”.
- Instrument de sigilare/verificare a integrității copiilor, cu permisiuni
  private, refuz la suprascrierea manifestului și detecția fișierelor lipsă,
  noi sau modificate. Nu pretinde că a restaurat baze de date.
- Scanare de secrete blocantă, cu versiune Gitleaks și amprentă de distribuție
  fixate. Excepțiile sunt exclusiv valori sintetice exacte, în căi exacte
  de teste; nu sunt excluse directoare întregi.

## Probe executate local

| Verificare | Rezultat |
|---|---|
| Compilare TypeScript fără emitere | Trecută |
| Suita TypeScript completă | 1.243 trecute; 2 eșuate; 1.245 total |
| Regresii noi de guvernanță și execuție, incluse în total | 13/13 trecute |
| Regresii Python de bot, STOP, memorie, monitorizare, surse, backup, replicare și izolare | 28/28 trecute |
| Regresii de izolare în imaginea instalată | 7/7 trecute, fără apeluri externe ale dublurilor de test |
| Scanare Gitleaks a arborelui curent | Fără semnalări neexceptate |
| Scanare Gitleaks a istoricului local accesibil, 249 commit-uri scanate înainte de documentarea finală | Fără semnalări neexceptate |
| Verificare sintactică Python și Bash | Trecută |
| Inspecție de citire pe trei gazde; comparație Hetzner–Contabo | Executate; 22 fișiere plus arhiva separată identice |
| Instalare și replicare Hetzner–Contabo | Executate după aprobare; cod zero, 23 fișiere identice, permisiuni verificate |
| Instalare bot izolat | Executată și verificată în limitele lotului; fără probă plătită integrală |
| Restaurare reală, instalare runtime general, integrare continuă la distanță | Neexecutate |

Cele două eșecuri sunt în `tests/knowledge/equivalence.test.ts` și
`tests/knowledge/stage-def.test.ts`: amprentele aprobate ale orchestratorului
nu mai corespund candidatului modificat. În plus, tipul rezultatului de audit
s-a extins cu starea `admitted`; amprenta fișierului de audit trebuie revizuită.
Referințele nu au fost schimbate. Aceste porți rămân blocate până la acceptarea
explicită a noilor proprietăți și a octeților exacți.

Testele au fost scrise și executate în același flux de implementare. Ele sunt
probe de regresie, nu o verificare independentă a candidatului.

## Limite de instalare

Orchestratorul nu are încă un resolver de mandate conectat la autoritatea
operațională. În absența lui, refuză inferența. Aceasta este o restricționare
intenționată, nu funcționalitate completă; candidatul nu se instalează ca
înlocuitor transparent al producției.

Botul are eliminarea montărilor privilegiate și izolarea prin socket aplicate
pe gazdă. Rotația cheilor nu este executată. Funcțiile istorice nefolosite nu
sunt un executor autorizat. STOP este probat cu așteptări asincrone simulate,
nu ca revocare retroactivă a unei cereri acceptate de alt serviciu.

Instrumentul de integritate este testat separat. Scriptul de backup din Git
diferă de cel instalat, deci nu trebuie copiat peste producție; se va aplica o
corecție minimă după citirea versiunii curente. Nu a fost modificată replicarea
off-site decât în limitele lotului aprobat și documentat mai jos. Retenția
independentă nu a fost instituită. Scriptul de backup al sursei rămâne neschimbat.

## Registrul tuturor constatărilor

| Constatare | Stadiu și probă lipsă |
|---|---|
| F01 Autoritate directă | Izolare instalată: fără rețea directă, Docker, SSH sau chei în procesul conversațional; executorul extern cu mandat și acceptarea integrală rămân necesare |
| F02 Guvernanță după inferență | Refuz anterior inferenței testat; autoritate operațională și rută atestată de conectat |
| F03 Continuitate și STOP | Coada persistentă instalată; recepție verificată; STOP și shutdown testate cu dubluri în imaginea exactă, nu prin efecte externe reale |
| F04 Memorie ca instrucțiune | Rol și proveniență corectate în botul instalat; revocare semantică și contradicții încă de probat |
| F05 Acces gazde | Configurația citită pe trei gazde; nicio schimbare aplicată; recuperarea și migrarea accesului trebuie aprobate |
| F06 Credenciale | Valori eliminate din procesul conversațional și separate în releu; revocarea la furnizori și protejarea tuturor copiilor încă neefectuate |
| F07 Execuție fictivă | Refuz testat în absența executorului; executarea autorizată reală încă de integrat |
| F08 Cod de ieșire pierdut | Rezultat structurat testat în ajutorul istoric; comenzile administrative sunt blocate în bot, nu acceptate ca executor operațional |
| F09 Citire care ascunde scrierea | Separare instalată și testată cu dubluri; confirmarea per înregistrare și reluarea idempotentă necesită contractul serviciului |
| F10 Politici și registre divergente | Reviziile active și căile auditului recitite; divergența persistă; corelarea unui traseu real lipsește |
| F11 Integrare și scanare | Scanare blocantă pregătită; două porți locale rămân blocate; analiza alertelor și revizia umană încă necesare |
| F12 Confirmarea pauzei | Neînchis; remedierea ramurii de dezvoltare nu este inclusă în acest candidat pornit din main |
| F13 Raportare de maturitate | Acest registru distinge codul local de producție; corectarea tuturor înregistrărilor istorice rămâne de făcut |
| F14 Abatere la reconstrucție | Neînchis; nu s-a rescris referința pentru a ascunde abaterea |
| F15 Reconstrucție incompletă | Botul este versionat și instalat cu amprente; backupul noii stări, manifestul integral al producției și restaurarea rămân de făcut |
| F16 Repornire și probe | Bot și releu au probe și politici explicite; supraviețuirea la repornirea gazdei și restul serviciilor rămân de verificat |
| F17 Backup și alarme | Procedura off-site instalată și verificată; identitate a 23 de fișiere, destinație privată, latest corect, erori neascunse; retenție independentă, restaurare și alarmă sintetică încă necesare |
| F18 Calitatea informației | Neînchis; necesită eșantion de proveniență și verificare semantică |
| F19 Plan de control nou | Amânat până după închiderea porților de autoritate și reconstrucție |
| F20 Cost și misiuni | Neînchis; nicio modificare financiară sau reconciliere în producție |
| F21 Acoperire supraestimată | Raport corectat local; surse energetice și măsurarea deduplicării recente încă necesare |
| F22 Raport operațional incomplet | Lista și numărarea corectate local; acoperirea tuturor gazdelor și autentificarea livrării încă necesare |

## Precizări asupra probei E18

Cele două sau trei potriviri de tipare din fiecare copie a botului nu reprezintă
un inventar exhaustiv al cheilor și nu demonstrează că acele chei sunt active.
Permisiunea 644 trebuie evaluată împreună cu traversabilitatea directoarelor,
listele de acces și montările; singură nu dovedește accesul tuturor utilizatorilor.
Autentificarea ca root la destinație nu dovedește un shell nelimitat fără
verificarea opțiunilor cheii și a configurației efective.

`rsync --delete` propagă ștergerile, dar nu demonstrează că toate formele de
corupere sunt detectate sau propagate. Lipsa unui manifest criptografic
persistent nu înseamnă că protocolul rsync nu verifică transferul. Un cod zero
din jurnalul gazdei sursă nu substituie citirea destinației și restaurarea.

## Următoarea poartă

Citirea, lotul de replicare și izolarea botului aprobate sunt încheiate.
Următoarele dependențe sunt accesul CIDA numai pentru citire, backupul noii stări
a botului, restricționarea sursei fără întreruperea cititorului DigitalOcean,
migrarea accesului, revocarea cheilor expuse și restaurarea izolată.
Aceste intervenții și instalarea runtime-ului au criterii distincte de acceptare
și revenire; nu sunt autorizate implicit prin loturile deja executate.
Nu se dezactivează controalele ca să treacă un test și nu se schimbă versiunea
acceptată doar fiindcă există cod nou.

## Evidență istorică: verificarea gazdelor, 23 septembrie, 20:02–20:07 UTC

Etapa de citire a fost executată pe cele trei gazde. Nu s-au modificat configurații,
servicii, chei sau copii de siguranță. Conexiunile au folosit verificarea strictă a
cheilor de gazdă deja salvate; Contabo a fost accesat prin Hetzner, fără copierea
cheii private. Aceasta probează continuitatea față de cheile salvate, nu o nouă
atestare independentă a identității furnizorului.

- Cele 22 de fișiere din fotografia `20260923-023001` au aceleași dimensiuni și
  amprente SHA-256 pe Hetzner și Contabo. Arhiva separată de secrete, 100.715
  octeți, a fost comparată separat și este identică, cu modul 600 pe ambele gazde.
  Aceste probe nu sunt restaurare și nu dovedesc completitudinea datelor exportate.
- Lanțul de directoare al fotografiei este 755; 21 din cele 22 de fișiere sunt
  citibile de grup sau de ceilalți utilizatori pe ambele gazde. Nu s-a demonstrat
  acces public prin internet și nici exfiltrare.
- `latest` pe Contabo este o legătură absolută către calea Hetzner, inexistentă pe
  Contabo. Datele datate există; defectul este al legăturii de descoperire.
- Conexiunea root Hetzner–Contabo permite comenzi generale. Niciuna dintre cele
  trei chei root autorizate pe Contabo nu are opțiune de comandă impusă.
- DigitalOcean are încă o copie secundară trasă prin utilizatorul `ronor` de pe
  Hetzner, cu comparare de amprente pentru fișierele selectate. Prin urmare,
  afirmația că există o singură destinație off-site nu este justificată.
  Scriptul DigitalOcean nu copiază volumele din secțiunea 3b și exclude explicit
  arhivele separate de secrete. Citirea codului nu probează ultima sa execuție.
- Restrângerea tuturor permisiunilor Hetzner la root ar întrerupe acest cititor.
  Este necesară mai întâi migrarea sau păstrarea unui acces explicit de citire.
- Scriptul off-site poate masca eșecul rsync prin succesul comenzii SSH de la final;
  scriptul backup poate înregistra eșecuri fără ieșire nenulă. `--delete` propagă
  ștergerile și nu asigură retenție independentă.
- Botul are aceeași amprentă ca la audit; montările Docker și SSH administrative
  sunt încă prezente. Politicile din runtime-urile generale sunt încă versiunea
  `build-week-2026.07.20`; controllerul de dezvoltare folosește `2026.09.18`.
  `PERSISTENCE_REQUIRED=false` este încă setat în cele două runtime-uri generale.
- Configurația generală SSH permite parole pe toate trei gazdele. Pentru root,
  Hetzner și Contabo raportează `without-password`, iar DigitalOcean `yes`.
  Nu s-au testat parole, conturi cu parolă utilizabilă sau toate regulile Match.

Au fost adăugate `offsite_sync.sh`, `offsite_verify.py` și opt regresii locale.
Noua procedură refuză cheile de gazdă necunoscute, conservă codurile de eșec,
nu propagă ștergeri, restrânge permisiunile destinației și verifică fotografia
datată plus arhiva separată înainte de publicarea unei legături relative `latest`.
Suita Python este acum 21/21; integrarea continuă selectează toate testele ops.

Procedura rămâne un mirror întărit: poate suprascrie fișiere cu același nume și
folosește încă root. Nu se declară retenție imuabilă, restaurare sau F17 închis.
La încheierea citirii, nicio instalare nu avusese loc. Cele două porți TypeScript
nu au fost schimbate. Aprobarea și instalarea ulterioară sunt consemnate separat.

## Evidență istorică: lot off-site instalat, 23 septembrie, 20:25–20:27 UTC

Utilizatorul a aprobat explicit numai lotul de replicare descris, nu instalarea
restului candidatului. Au fost instalate două fișiere din revizia `6092289`,
după verificarea amprentei scriptului anterior și sub blocajul comun de replicare.
Programarea existentă, `30 4 * * *`, nu a fost modificată.

| Obiect | SHA-256 și stare |
|---|---|
| Scriptul Hetzner `/usr/local/sbin/ronor-offsite.sh` | `9ccb672eadee22b7d80ef33f5cceac6969094e19a5d6a4e473a43e04c75a23c6`; root:root, 700 |
| Verificatorul `/usr/local/lib/ronor/offsite_verify.py` | `7a536c9ad50b934f84b8113332edd9a88b6e69059ff821e7b334c181e06f7a3b`; root:root, 600 |
| Scriptul anterior conservat pe Hetzner | `637b49698470e6411d9ed80b9dd3361ce51ca97c937fd9785ccc43a4eeddae6c`; copie 600 în director 700 |

Copie de revenire: `/root/ronor-offsite-repair-20260923-2025/ronor-offsite.before.sh`.
Nu se reactivează automat scriptul anterior: acesta ar putea reaplica drepturile
permisive și propagarea ștergerilor la următoarea rulare.

### Acceptarea lotului

- **Rulare unică:** început la `2026-09-23T20:26:03Z`; procesul și procedura au
  raportat cod 0. Nu s-a executat încă o a doua replicare sau o restaurare.
- **Conținut:** toate cele 22 de fișiere ale fotografiei `20260923-023001`, plus
  arhiva separată de secrete, au dimensiuni și amprente SHA-256 identice.
- **Descoperire:** `latest` de pe Contabo este acum legătura relativă
  `20260923-023001`, rezolvabilă în interiorul destinației.
- **Permisiuni:** rădăcina și directoarele fotografiei sunt 700, iar arhiva de
  cod și cea de secrete sunt 600, root:root. Inspecția celor 1.337.331 de obiecte
  nesimbolice din destinație a găsit zero obiecte cu proprietar diferit de root
  și zero cu drepturi pentru grup sau ceilalți. Aceasta este verificare de
  metadate, nu comparare de conținut pentru întregul istoric.
- **Probă negativă:** utilizatorul `nobody` nu poate citi arhiva off-site.
  Proba este `test -r`, nu citire sau copiere a datelor.
- **Dependență păstrată:** utilizatorul `ronor` de pe Hetzner poate încă citi
  `latest/postgres/cida.dump`. Nu s-au schimbat permisiunile sursei; aceasta nu
  este o execuție completă a copiei secundare DigitalOcean.
- **Domeniu respectat:** codul botului are aceeași amprentă ca înainte. Nu s-au
  modificat autentificarea, cheile, firewallul, containerele sau politicile de
  guvernanță. Nu s-a făcut push sau merge în GitHub.

### Limite care rămân deschise

Retenția destinației nu mai urmărește ștergerile sursei, dar destinația rămâne
modificabilă prin root și fișierele cu același nume pot fi suprascrise. Nu există
încă probă de restaurare, imutabilitate, alarmă livrată sau acceptare a întregului
runtime. Controalele de drift pot semnala justificat schimbările; referința lor
nu a fost rescrisă pentru a masca intervenția.

Arhivele sursă de pe Hetzner rămân cu permisiunile observate anterior. Migrarea
lor trebuie să păstreze accesul explicit al copiei DigitalOcean, iar scriptul
de export are încă ramuri care pot declara succes după export parțial. Aceste
limite nu sunt închise prin fidelitatea transferului.
