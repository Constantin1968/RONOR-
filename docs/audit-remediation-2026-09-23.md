# RONOR: registrul remedierilor auditului din 23 septembrie 2026

Stadiu: candidat local, nepublicat și neinstalat. Bază: `a857989`, ramura
integrată citită din GitHub în această sesiune. Solicitarea de reparare integrală
nu este încă îndeplinită. Nicio constatare nu este declarată închisă în producție.

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
| Regresii Python de bot, STOP, memorie, monitorizare, surse, backup și replicare | 21/21 trecute după completarea off-site |
| Scanare Gitleaks a arborelui curent | Fără semnalări neexceptate |
| Scanare Gitleaks a istoricului local accesibil, 242 commit-uri | Fără semnalări neexceptate |
| Verificare sintactică Python și Bash | Trecută |
| Inspecție de citire pe trei gazde; comparație Hetzner–Contabo | Executate; 22 fișiere plus arhiva separată identice |
| Restaurare reală, instalare, integrare continuă la distanță | Neexecutate |

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

Botul nu are încă eliminarea montărilor privilegiate aplicată pe gazdă, o
politică externă de rețea sau cheia nouă injectată. Funcțiile istorice nefolosite
nu sunt un executor autorizat. STOP este probat local pe așteptări asincrone,
nu ca revocare retroactivă a unei cereri acceptate de alt serviciu.

Instrumentul de integritate este testat separat. Scriptul de backup din Git
diferă de cel instalat, deci nu trebuie copiat peste producție; se va aplica o
corecție minimă după citirea versiunii curente. Nu a fost modificată replicarea
off-site în producție și nu a fost instituită retenția independentă. O corecție
locală separată a replicării este pregătită după inspecția gazdelor.

## Registrul tuturor constatărilor

| Constatare | Stadiu și probă lipsă |
|---|---|
| F01 Autoritate directă | Restricționare locală; executor extern cu mandat, montări și acceptare pe gazdă încă necesare |
| F02 Guvernanță după inferență | Refuz anterior inferenței testat; autoritate operațională și rută atestată de conectat |
| F03 Continuitate și STOP | Corecție locală testată; probă pe botul instalat și cădere controlată încă necesare |
| F04 Memorie ca instrucțiune | Rol și proveniență corectate local; revocare semantică și contradicții încă de probat |
| F05 Acces gazde | Configurația citită pe trei gazde; nicio schimbare aplicată; recuperarea și migrarea accesului trebuie aprobate |
| F06 Credenciale | Valori eliminate din candidatul botului; revocarea la furnizori și protejarea copiilor încă neefectuate |
| F07 Execuție fictivă | Refuz testat în absența executorului; executarea autorizată reală încă de integrat |
| F08 Cod de ieșire pierdut | Rezultat structurat testat; instalare neefectuată |
| F09 Citire care ascunde scrierea | Separare testată; confirmarea per înregistrare și reluarea idempotentă necesită contractul serviciului |
| F10 Politici și registre divergente | Reviziile active și căile auditului recitite; divergența persistă; corelarea unui traseu real lipsește |
| F11 Integrare și scanare | Scanare blocantă pregătită; două porți locale rămân blocate; analiza alertelor și revizia umană încă necesare |
| F12 Confirmarea pauzei | Neînchis; remedierea ramurii de dezvoltare nu este inclusă în acest candidat pornit din main |
| F13 Raportare de maturitate | Acest registru distinge codul local de producție; corectarea tuturor înregistrărilor istorice rămâne de făcut |
| F14 Abatere la reconstrucție | Neînchis; nu s-a rescris referința pentru a ascunde abaterea |
| F15 Reconstrucție incompletă | Botul și modulele noi sunt versionate local; manifestul exact al producției și restaurarea rămân de făcut |
| F16 Repornire și probe | Neaplicat pe gazde; rolurile permanente trebuie verificate înaintea schimbării politicilor |
| F17 Backup și alarme | Fotografia și arhiva separată identice între gazde; procedură corectată local; instalare, retenție independentă, restaurare și alarmă sintetică încă necesare |
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

Citirea aprobată este încheiată. Urmează aprobarea explicită a lotului de
replicare descris în `ops/hetzner/OFFSITE-DEPLOYMENT.md`, apoi instalarea și
verificarea lui. Restul intervențiilor, rotațiile și instalarea runtime-ului au
criterii distincte de acceptare și revenire. Nu se dezactivează controalele ca
să treacă un test și nu se schimbă versiunea acceptată doar fiindcă există cod nou.

## Verificarea autorizată a gazdelor, 23 septembrie, 20:02–20:07 UTC

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
Nicio instalare nu a avut loc. Cele două porți TypeScript nu au fost schimbate.
