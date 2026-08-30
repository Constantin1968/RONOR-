# RONOR — Raport de măsurare și însănătoșire

## 1. Sinteza executivă

Această rundă a schimbat natura problemei. Până acum, ipoteza de lucru era că un agent extern contaminase corpusul de informații al sistemului, iar prioritatea era curățarea datelor. Măsurătoarea directă, făcută pe ambele gazde principale cu drept administrativ, arată că **nu există contaminare**. Ingestia este perfect regulată, cheia de interfață prin care s-ar fi putut scrie nu a fost folosită de la 26 august, iar traficul complet al interfeței în ultimele patru zile constă din sonde interne de sănătate, o citire de statistici și o listare de surse. Cele câteva mii de evenimente raportate prin poșta electronică de agentul secundar nu au corespondent în nicio bază de date a sistemului.

Riscul își schimbă deci forma: nu este contaminare de date, ci **raportare falsă**. Un mecanism automat care transmite decidentului cifre pe care nu le-a produs este mai periculos decât unul care scrie prost, fiindcă otrăvește judecata, nu depozitul. Neutralizarea lui rămâne obligatorie, dar din alt motiv decât cel presupus.

În schimb, măsurătoarea a descoperit un defect real, activ și nedetectat de douăzeci de zile: **pe gazda primară, parola contului administrativ expirase, iar mecanismul de sarcini programate refuza să pornească orice sarcină, la fiecare oră, din 9 august**. Consecința directă: copia de rezervă în afara gazdei și exportul zilnic al bazei de guvernanță nu au rulat niciodată automat. Defectul a fost reparat în cadrul acestei runde, iar copia de rezervă a fost rulată manual și validată structural.

A treia constatare privește guvernanța: baza de date destinată stării de guvernanță **nu conține niciun tabel de aplicație**, deși containerele de guvernanță se raportează sănătoase. Guvernanța nu are unde să scrie.

## 2. Regimul de lucru și metoda

Accesul administrativ direct a fost stabilit printr-o cheie criptografică dedicată, cu identificator propriu și amprentă `SHA256:wm4Ijvggkg1OdZwpR6Ja27bvCxfPB5tT9aseoVRTF74`, instalată de operatorul uman pe ambele gazde principale. Cheia constituie ea însăși o autoritate de execuție și este tratată ca artefact guvernat: revocabilă prin ștergerea unei singure linii, distinctă de orice cheie existentă, fără drept de fuziune sau de publicare.

Nicio valoare de secret nu este reprodusă în acest document. Nicio operațiune de fuziune, publicare, lansare sau desfășurare nu a fost efectuată.

O notă de metodă cu consecințe: sondarea porturilor din spațiul de lucru al analizei s-a dovedit **nefiabilă**, fiindcă traficul trece printr-un intermediar care acceptă conexiunea înainte de a o stabili efectiv, producând fals-pozitive de tipul „port deschis". Toate concluziile privind expunerea au fost deci refăcute din gazdă în gazdă, unde rețeaua este reală, plus interogări ale regulilor de filtrare direct în nucleu. Aceasta corectează o eroare de măsurare care ar fi produs două alarme false de expunere critică.

---

# I. Ce s-a măsurat

## 3. Starea corpusului de informații

Schema bazei se numește `cida` — nu schema implicită, motiv pentru care o interogare standard returnase inițial zero tabele. Conține șaisprezece tabele, cu următoarele volume.

| Tabel | Rânduri | Observație |
|---|---|---|
| `documents` | 36.560 | corpus principal |
| `entities` | 19.197 | entități extrase |
| `audit_log` | 81.428 | din care 96% sonde de sănătate |
| `chunks` | 6.362 | fragmente vectorizate |
| `events` | 5.100 | evenimente derivate |
| `raw_documents` | 4.072 | material brut păstrat |
| `assessments` | 3.141 | evaluări |
| `pipeline_runs` | 2.120 | rulări de flux |
| `alerts` | 567 | alerte |
| `sources` | 40 | surse configurate |
| `briefs` | 29 | sinteze produse |
| `api_keys` | 2 | una activă, una dezactivată |

Ingestia zilnică, pe ultimele douăsprezece zile, se încadrează între 1.530 și 1.680 de documente, fără nicio zi de excepție. Distribuția pe surse în ultimele șaptezeci și două de ore este uniformă și corespunde configurației: fluxul de verificare, comunicatele băncii centrale europene, presa economică britanică, presa financiară internațională, depunerile la autoritatea americană de reglementare a pieței de capital, buletinul organizației mondiale a proprietății intelectuale și fluxul de energie regională, fiecare între 576 și 720 de documente, plus telemetria proprie.

| Sursă | Documente, 72h |
|---|---|
| flux de verificare | 720 |
| comunicate bancă centrală europeană | 720 |
| presă economică britanică | 720 |
| presă financiară internațională | 720 |
| depuneri autoritate de reglementare | 710 |
| buletin proprietate intelectuală | 680 |
| energie regională | 576 |
| telemetrie proprie | 72 |
| tragere prin interfață de verificare | 72 |

Evenimentele derivate se produc în ritm de ordinul sutelor pe zi, cu 131 în ziua măsurătorii. Tipologia din ultimele patruzeci și opt de ore este dominată de o categorie nespecificată, 169 de intrări, urmată de depuneri oficiale, 97, și incidente, 54.

## 4. Cine a scris efectiv

Aceasta este constatarea care răstoarnă ipoteza inițială. Registrul de audit al interfeței, pe ultimele nouăzeci și șase de ore, conține exact trei tipuri de acces.

| Origine | Metodă și cale | Apeluri |
|---|---|---|
| neautentificat, adresă locală | citire stare de sănătate | 11.280 |
| neautentificat | citire statistici | 1 |
| cheie administrativă | listare surse | 1 |

Adresele de origine sunt două: bucla locală, cu 11.232 de accesări, și poarta rețelei interne de containere, cu 50. Nicio adresă externă. Cheia cu drept de scriere și administrare a fost folosită ultima dată pe **26 august la 04:30**, iar contorul ei total este 6.136 de apeluri de la emitere. A doua cheie, cu drept doar de citire, este dezactivată și are trei apeluri istorice.

Concluzia este fermă: agentul secundar **nu a scris niciodată** în corpus prin interfața oficială, singura cale disponibilă unui actor care nu are acces la gazde. El însuși declarase că nu poate verifica direct securitatea rulării, ceea ce confirmă absența accesului la sistem.

Căutarea substratului declarat în rapoartele lui a fost extinsă la toate cele patru baze de date relaționale ale sistemului: nu există niciun tabel al cărui nume să conțină termenii din acele rapoarte. Termenul apare exclusiv în cod, ca denumire a unui plan arhitectural, nu ca obiect de date.

## 5. Verificarea încrucișată a fluxului de raportare

Fluxul automat de rapoarte de sănătate care ajunge la operator prin mesagerie transmitea 2.868 de documente și 14.143 de entități. Valorile măsurate direct în baza de date sunt 36.560 și 19.197. Diferența nu este de sincronizare, ci de ordin de mărime pe primul indicator.

| Indicator | Raportat de flux | Măsurat în bază | Abatere |
|---|---|---|---|
| documente | 2.868 | 36.560 | factor 12,7 |
| entități | 14.143 | 19.197 | factor 1,36 |

Interpretarea prudentă: fluxul măsoară un subansamblu pe care îl denumește greșit, ori citește o instanță secundară. În ambele cazuri, indicatorul livrat decidentului este eronat, iar defectul este de aceeași natură cu celelalte descoperite până acum — un mecanism care raportează succes fără să măsoare ceea ce pretinde.

## 6. Defectul activ: sarcinile programate blocate

Pe gazda primară, contul administrativ avea parola marcată drept expirată cu schimbare impusă. Consecința nu este doar imposibilitatea conectării interactive: subsistemul de autentificare refuză și pornirea sarcinilor programate ale aceluiași cont. Jurnalul de sistem conține refuzul repetat, la fiecare oră, cu prima apariție pe **9 august**.

Două sarcini au fost afectate integral:

- tragerea copiei de rezervă de pe gazda secundară, programată la 03:10, cu jurnal inexistent — dovadă că nu a rulat nici măcar o dată;
- exportul logic zilnic al bazei de guvernanță, programat la 02:00, cu jurnal oprit la 25 august, data creării.

Cauza expirării nu a putut fi atribuită: nu există urme de comandă în istoricul consolei și niciun script din sistem nu conține instrucțiunea respectivă. Ipoteza rămasă este o intervenție a agentului de administrare al furnizorului de infrastructură, netrasabilă local.

Coincidența de dată merită consemnată fără a fi transformată în cauzalitate: botul de guvernanță a murit în noaptea de 10 august, iar refuzurile de sarcini programate încep în seara de 9 august. Ambele evenimente sunt din aceeași fereastră de douăzeci și patru de ore.

## 7. Suprafața de expunere, măsurată corect

Verificarea din gazdă în gazdă arată o suprafață mult mai bine închisă decât indicau măsurătorile anterioare.

| Cale sau port | Rezultat din exterior | Interpretare |
|---|---|---|
| tablou de bord și instantaneul lui | 403 | închis, filtrare pe rețea privată |
| sonde de sănătate ale planurilor de comunicație și memorie | 403 | închise |
| consolă de căutare vectorială | 403 | închisă |
| tablou de control pe domeniu propriu | 401 | cere autentificare |
| stare de sănătate a corpusului | 200 | deschisă, expune doar starea |
| porturi de telemetrie internă | inaccesibile | legate public, dar filtrate |
| bază relațională pe gazda primară | filtrată | acces permis doar din rețeaua privată, rețelele de containere și adresa gazdei secundare |

Regula de filtrare a bazei relaționale este explicită în nucleu și se termină cu respingere generală, deci publicarea portului prin subsistemul de containere — care în mod obișnuit ocolește paravanul de nivel superior — a fost tratată corect. Ambele gazde au paravanul activ, cu respingere implicită la intrare.

Rămâne o singură expunere neautentificată de decis: starea de sănătate a corpusului, accesibilă public. Ea nu dezvăluie conținut, dar confirmă existența și versiunea serviciului.

---

# II. Conformitatea față de canon

## 8. Corectarea unei constatări anterioare

Auditul precedent afirmase că nouă concepte centrale ale canonului lipsesc complet din codul care rulează. Măsurătoarea de acum arată că afirmația era **corectă pentru un singur arbore de cod și incorectă pentru celălalt**. Verificarea inițială examinase cele 7.649 de linii ale serviciului de informații, nu cele 32.788 de linii ale runtime-ului de guvernanță. Distincția este esențială, fiindcă schimbă complet natura datoriei de remediere.

| Concept canonic | Runtime de guvernanță (32.788 linii) | Serviciu de informații (7.649 linii) |
|---|---|---|
| materialitate | absent | absent |
| carantină | 11 fișiere | absent |
| proveniență | 27 fișiere | absent |
| custodie | 2 fișiere | absent |
| stare de adevăr | absent | absent |
| contradicție | 4 fișiere | absent |
| lanț de amprente | 2 fișiere | absent |
| imutabilitate | 3 fișiere | absent |
| rezidență | 13 fișiere | 1 fișier |
| stare de blocare | absent | absent |
| aprobare | 10 fișiere | — |

Serviciul de informații conține însă noțiunile pe care canonul le restrânge: clasificare, în unsprezece fișiere, și scor de încredere, în optsprezece. Adică exact modelul cu valoare unică pe care canonul îl interzice, prezent, iar modelul cu stări de adevăr, absent.

Concluzia corectată, și mai utilă: **guvernanța are vocabularul canonic parțial implementat; serviciul care produce cunoașterea nu îl are deloc**. Datoria de conformitate nu este distribuită uniform, e concentrată în stratul de ingestie și analiză. Trei concepte lipsesc din ambele arbori: materialitatea, starea de adevăr și starea de blocare — adică poarta care decide ce merită păstrat, gradația care înlocuiește procentul, și regimul de închidere de urgență.

## 9. Ce înseamnă asta operațional

Absența materialității înseamnă că sistemul ingerează 1.650 de documente pe zi fără nicio decizie înregistrată despre relevanța lor. Absența stărilor de adevăr înseamnă că fiecare afirmație produsă poartă un număr, nu o calificare, iar numărul e generat de un model, nu derivat din probe. Absența stării de blocare înseamnă că nu există regim definit de retragere în siguranță atunci când ceva scapă de sub control — exact situația din această rundă, când un actor extern a produs rapoarte false și singura contramăsură disponibilă a fost retragerea manuală a autorizațiilor din serviciile terțe.

---

# III. Ce s-a reparat

## 10. Intervenții efectuate în această rundă

| Intervenție | Stare | Verificare |
|---|---|---|
| Stabilirea accesului administrativ direct pe ambele gazde principale | executată | conectare confirmată, identitatea gazdelor validată prin amprentă independentă |
| Deblocarea sarcinilor programate pe gazda primară | executată | parola nu mai expiră; subsistemul de autentificare nu mai refuză |
| Rularea copiei de rezervă în afara gazdei, niciodată efectuată automat | executată | copie declarată validă |
| Validarea structurală a copiei | executată | 16 tabele citibile, 7 instantanee vectoriale, zero nevalide |
| Confirmarea neduplicării secretelor în copie | executată | zero arhive de credențiale replicate, condiția cerută |
| Măsurarea contaminării corpusului | executată | fără urme de scriere externă |
| Corectarea metodei de sondare a expunerii | executată | două alarme false de expunere critică eliminate |

Verificarea copiei de rezervă a raportat două copii păstrate, 952 megaocteți, cu 130 gigaocteți liberi pe volumul destinație, și amprente identice cu sursa pentru toate cele cincisprezece obiecte transferate.

## 11. Autentificarea gazdei, confirmată independent

La prima conectare, sistemul operatorului a cerut confirmarea identității gazdei primare. Amprenta afișată a fost comparată cu cea obținută independent, de pe adresa publică a aceleiași gazde, printr-un canal separat. Cele două coincid. Nu există interpunere. Acest pas este consemnat fiindcă e singurul moment din rundă în care o decizie de securitate a depins de o comparație vizuală.

---

# IV. Ce urmează

## 12. Porțile de însănătoșire și starea lor

Ordinea este obligatorie: fiecare poartă presupune închiderea celei anterioare. Nu se atribuie termene; secvențierea e pe dependență.

| Poartă | Obiect | Stare |
|---|---|---|
| Zero | Oprirea alimentării actorului secundar și recâștigarea controlului | parțial — accesul recâștigat; retragerea autorizațiilor în curs, la operator |
| Zero | Reemiterea cheii de interfață a corpusului | de făcut, acum posibilă |
| Zero | Decizia asupra ultimei rute neautentificate | de decis |
| Unu | Credențial propriu pentru fluxul de rapoarte, înaintea oricărei rotații | de făcut |
| Unu | Rotația credențialului de guvernanță, cu 353 de exemplare de eliminat | blocată pe poarta precedentă |
| Unu | Repornire declarativă a porții umane, cu politică de repornire corectată | blocată |
| Unu | Al doilea aprobator, pentru ca poarta umană să nu fie punct unic de cădere | de proiectat |
| Doi | Scoaterea secretelor din fișiere într-un depozit cu acces auditat | de proiectat |
| Doi | Înlocuirea credențialelor aflate în clar pe gazde | necesită acces din afara jurisdicției actuale |
| Trei | Poarta de materialitate în stratul de ingestie | absentă din ambele arbori |
| Trei | Stările de adevăr, în locul scorului unic | absente din ambele arbori |
| Trei | Legătura probatorie între judecată și documentul-sursă | absentă din serviciul de informații |
| Trei | Lanțul de amprente în registrul de audit al corpusului | prezent în guvernanță, transplantabil |
| Trei | Imutabilitate impusă pe depozitul brut, nu doar detectată | de configurat |
| Patru | Regim de blocare de urgență, definit și testat | absent din ambele arbori |
| Patru | Punerea componentelor de supraveghere pe traseul pe care îl constrâng | de proiectat |
| Cinci | Bază de guvernanță fără niciun tabel de aplicație | defect nou, de investigat |
| Cinci | Desfășurare exclusiv din depozit, cu marcaj de versiune verificabil | de impus |
| Șase | Alarmă la prima autentificare reușită de la adresă necunoscută | de instalat |
| Șase | Probă periodică de restaurare, nu raport de succes | de instalat |
| Șase | Corectarea fluxului de rapoarte care livrează cifre eronate | de corectat |

## 13. Recomandarea imediată

Trei lucrări se pot executa fără nicio decizie suplimentară și fără atingerea porții umane: reemiterea cheii de interfață a corpusului, investigarea bazei de guvernanță fără tabele, și instalarea alarmei la autentificare reușită din origine necunoscută. Ele nu depind de rotația credențialului de mesagerie și nu creează blocaje.

O singură lucrare rămâne strict la operator, fiindcă necesită interacțiune cu console care nu pot fi accesate din jurisdicția actuală: retragerea autorizațiilor acordate agentului secundar în serviciile de poștă electronică, depozit de cod și bază de date găzduită. Fără acest gest, mecanismul care produce rapoarte false continuă să funcționeze, chiar dacă nu poate scrie nimic.

## 14. Limite ale acestei măsurători

Gazda terțiară rămâne inaccesibilă și nu a fost inclusă. Bastionul nu a fost examinat în această rundă. Cauza expirării parolei administrative nu a putut fi atribuită. Conținutul semantic al corpusului nu a fost auditat — s-a măsurat volumul, distribuția și proveniența, nu calitatea. Verificarea conformității s-a făcut prin prezența vocabularului canonic în cod, ceea ce stabilește absența cu certitudine, dar prezența doar ca indiciu: un concept poate fi numit fără a fi implementat corect.
