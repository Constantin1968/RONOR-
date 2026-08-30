# Jurnalul deciziilor — RONOR / RSIOR

Consemnare a ceea ce s-a **măsurat**, a ceea ce s-a **decis** și a porților care
au rămas deschise. Ordinea e cea a etapelor de lucru, nu a importanței.

Regula de lectură: o afirmație apare aici numai dacă a fost verificată direct pe
gazdă, în cod sau în depozit. Unde o afirmație anterioară s-a dovedit greșită,
corecția e consemnată explicit, cu cauza greșelii. Nu se șterge nimic.

RSIOR = RONOR Sovereign Intelligence Operating Runtime.

---

## Reguli permanente de lucru

Acestea nu sunt recomandări. Sunt condiții sub care se desfășoară întreaga
lucrare.

**Fuziunea rămâne umană.** Nicio fuziune în `main`, nicio publicare de versiune
și nicio desfășurare nu se face fără acordul explicit al proprietarului, cerut
de fiecare dată, pentru fiecare operațiune. Ramurile se pregătesc, cererile de
integrare se deschid, verificările se rulează — dar butonul se apasă de om.

**Secretele nu se afișează.** Se confirmă numai lungimea, amprenta trunchiată
sau drepturile fișierului. Această regulă a fost încălcată o dată, într-o ieșire
de inspecție a unui container; încălcarea e consemnată mai jos, împreună cu
măsura de remediere care rămâne deschisă.

**Consolele terților nu se accesează din jurisdicția curentă de rețea.**
Administrarea la furnizorii de infrastructură și la furnizorii de modele se face
de proprietar, direct. Accesul prin rețeaua privată, prin SSH și prin apeluri de
interfață dinspre server e permis.

**Nimic nu se instalează pe stația de control fără întrebare.** Laptopul e
client de control, nu nod de execuție.

**Secvențierea se face pe porți de dependență, nu pe calendar.** O etapă începe
când poarta ei e deschisă de o măsurătoare, nu la o dată promisă.

---

## Etapa de constatare

**Măsurat.** Starea declarată a sistemului nu corespundea stării reale.
Verificarea de sănătate a serviciului de guvernanță întorcea răspuns favorabil
în condiții în care componente esențiale erau nefuncționale — un verde fals.
Inventarul complet e în `rapoarte/RONOR-RADIOGRAFIE-EXHAUSTIVA.md`, iar analiza
depozitului în `rapoarte/ronor-criminalistica-repo.md`.

**Decis.** Se pornește de la măsurătoare, nu de la documentație. Orice afirmație
despre capabilitate se verifică în codul care rulează efectiv, nu în codul din
depozit și nu în specificație. Diferența dintre cele trei s-a dovedit relevantă
în mai multe puncte.

## Etapa de reparație

**Măsurat.** Porțile de verificare obligatorii ale depozitului erau incomplete,
iar unele scripturi de producție apelate din programatorul de sarcini nu se
aflau sub control de versiune — existau numai pe gazdă, fără istoric și fără
posibilitate de revenire.

**Decis.** Scripturile de producție intră sub control de versiune. Porțile
obligatorii se completează la șase verificări, cu protecție strictă pe `main`:
construcție TypeScript, scanare de securitate, teste Jest, conformitate
R-Knowledge, echivalență de referință cu R-Knowledge dezactivat și contract de
pregătire pentru activarea automatizării.

Raportul de închidere al acestei etape: `rapoarte/RONOR-raport-de-inchidere-28aug2026.md`.

## Etapa de măsurare și însănătoșire

**Măsurat.** O cerere reală, executată cu cheia administrativă corectă, a produs
răspuns favorabil, a folosit modelul suveran găzduit local, prin transport
nativ, deci **fără cost extern**, și a deschis o contestație pe două porți de
guvernanță. Latența pentru o sarcină trivială a fost de ordinul zecilor de
secunde.

**Măsurat, cu corecția unei afirmații proprii anterioare.** Se afirmase, într-o
etapă precedentă, că registrul local de audit era gol. **Afirmația era greșită.**
Cauza greșelii: copierea din container a fost făcută numai pentru fișierul de
bază de date, fără jurnalul de scriere anticipată care îl însoțește; datele
existau, dar nu în fișierul copiat. Copiind toate componentele registrului,
valorile reale s-au dovedit nenule, iar lanțul de audit local conținea verigi
provenind din două perioade distincte, cu chei diferite, ceea ce confirmă
independent rotația de cheie efectuată anterior.

Lecția, consemnată ca regulă: un registru cu jurnal de scriere anticipată nu se
citește niciodată din copia unui singur fișier.

**Măsurat, rezultatul central al etapei.** Stratul de persistență era **cod
mort**. Funcțiile de înregistrare a evenimentelor de audit, de persistare a
misiunilor și de memorare existau, erau testate, dar **nu erau apelate de
nimeni** din afara propriului strat. Verificarea s-a făcut în trei locuri
independente: în sursa de pe gazdă, în codul compilat din interiorul imaginii
care rulează și în depozit. În toate trei, zero apelanți externi. Consecința
practică: cererile reale scriau în lanțul local de audit, iar tabela de
evenimente din baza de guvernanță rămânea la zero rânduri.

**Decis.** Se leagă lanțul de audit la baza suverană, prin oglindire, iar
verdele fals din verificarea de sănătate se elimină. Raportul complet al etapei:
`rapoarte/RONOR-masurare-insanatosire-30aug2026.pdf`.

## Etapa de persistență suverană

**Făcut.** S-a ridicat o interfață de date suverană în fața bazei de
guvernanță, pe rețeaua internă, cu rol de autentificare separat de rolul de
serviciu, iar serviciul de guvernanță a fost relegat la ea. Proba cap-coadă a
reușit: scriere acceptată, citire confirmată, acces anonim respins.

**Măsurat, expunere.** Niciunul dintre containerele noi nu publică porturi în
exterior. Sondarea dinspre a doua gazdă a confirmat că porturile relevante sunt
filtrate la nivel de firewall. Public ascultă numai serviciul de acces la
distanță și serverul web din față.

**Decis.** Cerința de persistență obligatorie rămâne **dezactivată** până la
măsurătoarea de confirmare. Motivul e explicit: activarea ei transformă un eșec
de scriere în refuz de serviciu, iar nu avem încă dovada că scrierea funcționează
cap-coadă în condiții reale.

**Deschis, fără fuziune.** Cererea de integrare care leagă lanțul de audit la
baza suverană e deschisă, cu toate cele șase verificări obligatorii favorabile
și cu `main` neatins. Specificația și raportul de implementare sunt în
`specificatii/`.

Două compromisuri din acea lucrare cer citire umană deliberată înainte de
fuziune, și sunt consemnate ca atare în raportul de implementare: amprenta fixată
a unui modul de lanț de amprente s-a schimbat și a fost actualizată în trei
porți, cu justificare scrisă; iar o condiție de echivalență de referință a fost
reformulată din verificarea unei stări favorabile în verificarea identității de
comportament între cele două moduri de rulare.

---

## Porți deschise

Ordinea e de dependență. O poartă nu se deschide înainte de cea de dinaintea ei.

**Fuziunea cererii de integrare a oglindirii.** Decizie umană. După fuziune și
desfășurare, măsurătoarea obligatorie: o cerere reală trebuie să producă un rând
în tabela de evenimente de audit, cu amprentă **identică** verigii din lanțul
local. Fără această identitate, oglindirea nu e dovedită, ci doar presupusă.

**Activarea persistenței obligatorii.** Numai după măsurătoarea de mai sus.

**Rotația parolei bazei de guvernanță.** Necesară din cauza unei greșeli
proprii: valoarea a fost expusă într-o ieșire de inspecție a containerului.
Operațiunea cere recrearea a patru containere și, în același pas, curățarea a
trei valori de configurare moarte, care nu se mai rezolvă sau care indică spre
un proiect găzduit abandonat.

**Extinderea vocabularului închis al tipurilor de evenimente de audit.**
Vocabularul actual nu poate exprima carantina, blocarea pe contradicție și
materialitatea. Sunt lipsuri față de canon, nu simple omisiuni de comoditate.
Cere migrație de schemă, modificare de cod și ciclu complet de verificare.

**Calibrarea porților de guvernanță și dimensionarea modelului.** Latența
observată pentru o sarcină trivială și escaladarea produsă pentru o întrebare
benignă indică fie porți prea sensibile, fie un model supradimensionat pentru
clasa de cereri. Se decide pe bază de măsurători, nu de impresie.

**Retragerea autorizațiilor agentului secundar din consolele terților.**
Operațiune strict a proprietarului, din motivul de jurisdicție de rețea
consemnat în regulile permanente.

---

## Supraveghere activă

Două sarcini programate rulează în regim strict de observare. Niciuna nu execută
fuziune, publicare sau desfășurare.

**Alarma de acces din origine necunoscută**, la interval de câteva ore, pe ambele
gazde. Citește jurnalul de alarmă, arhivează liniile raportate ca să nu fie
raportate de două ori, verifică faptul că detectorul e încă programat și
executabil, și raportează dacă alarma a fost dezarmată sau dacă o gazdă nu
răspunde. Zgomot cunoscut și așteptat: autentificările provenind din adresa de
ieșire a spațiului de lucru de execuție sunt conexiunile proprii ale
instrumentarului, nu intruziuni.

**Supraveghetorul cererilor de integrare verzi și blocate**, la interval de
câteva ore. Semnalează cererile care au toate verificările obligatorii
favorabile și sunt fuzionabile, dar pe care nimeni nu le-a fuzionat; semnalează
verificările obligatorii picate; și semnalează regresiile de protecție a
ramurii principale. Motivul existenței lui e concret: exact acest tip de
scăpare a oprit bucla o dată — verificările trecuseră, fuziunea nu s-a făcut,
nimeni nu a observat.

---

## Oglindirea pe stația de control

**Măsurat.** Munca acestei lucrări se desfășoară pe cele două gazde și în
depozit. Nimic din ea nu atinge stația de control. Încercarea de a oglindi
artefactele direct pe stație, prin puntea de dispozitiv, a eșuat: comenzile
rulează sub un cont de sistem izolat, care nu are drepturi în niciun folder în
afara propriului director temporar, iar acordarea de foldere din interfață nu
ajunge la acest canal de execuție. Trei încercări succesive, cu selecție refăcută,
au dat același refuz.

**Decis.** Oglindirea se face prin depozit, nu prin punte. Acest director e
consecința deciziei. Depozitul are istoric, are verificări automate și are un
mecanism de sincronizare mai fiabil decât orice copiere de fișiere: pe stația de
control, un singur `git pull` aduce fidel codul și documentele împreună.
