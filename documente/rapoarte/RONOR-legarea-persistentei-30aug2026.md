# RONOR — Legarea persistenței suverane și eliminarea verdelui fals

## 1. Sinteza

Serviciul de guvernanță RONOR raporta „sănătos" în timp ce baza de date de guvernanță era complet goală. Cauza a fost stabilită integral, nu presupusă, și are trei straturi suprapuse. Primul: stratul de persistență scria către un proiect de bază de date găzduit în afara infrastructurii proprii, care refuza fiecare cerere cu eroarea „schemă invalidă". Al doilea: containerul bazei de guvernanță și containerul serviciului se aflau pe rețele interne disjuncte, deci numele bazei nu se rezolva din serviciu, iar adresa de conectare directă era moartă. Al treilea, și cel decisiv: **stratul de persistență nu era chemat de nimeni**. Nici în codul sursă, nici în codul compilat din imaginea care rulează efectiv. Verificat prin numărarea apelurilor în afara stratului, în ambele arbori: zero.

Primele două straturi au fost reparate și probate în această sesiune. A fost ridicată o interfață de date suverană peste baza sigilată de guvernanță, pe rețeaua internă, accesibilă serviciului și inaccesibilă din exterior. Scrierea a fost probată cap-coadă cu un rând real, iar accesul anonim a fost dovedit respins. Serviciul a fost relegat la această interfață și recreat, cu revenirea posibilă în orice moment prin copia de siguranță a fișierului de mediu.

Al treilea strat este o problemă de cod, nu de infrastructură, și nu putea fi rezolvat prin configurare. A fost implementat, testat și depus ca cerere de integrare **#30**, cu toate cele șase verificări obligatorii trecute și `main` neatins. Integrarea rămâne umană, conform regimului convenit.

Un rezultat colateral important este o corecție a propriei mele măsurători anterioare. Am raportat în etapele precedente că registrul local de audit era gol. Nu era. Citirea acelei baze locale prin copiere ignora jurnalul de scriere anticipată, unde se aflau rândurile. Măsurată corect, cu toate cele trei fișiere copiate, baza locală conține **nouăsprezece verigi reale** de audit, înlănțuite criptografic, iar cererea de probă din această sesiune a produs verigile optsprezece și nouăsprezece. Lanțul local de amprente funcționează și a funcționat. Ce nu funcționa era oglindirea lui în registrul relațional interogabil.

Distincția contează pentru evaluarea riscului. Sistemul nu pierdea urma deciziilor. Le păstra într-un singur loc, local, într-un format greu de interogat, fără redundanță și fără posibilitatea de a fi consultat de alte componente. Pierderea acelui volum ar fi însemnat pierderea integrală a istoricului de guvernanță.

## 2. Ce s-a făcut

### 2.1 Migrația schemei de guvernanță, dusă la capăt

Schema `ronor` a fost aplicată integral în baza sigilată `ronor-gov-postgres`. Executarea se oprea anterior la crearea unei politici de securitate pe rând care referea un rol inexistent într-o instalare Postgres simplă — un rol specific platformei găzduite. Rolul a fost creat fără drept de conectare, politica a fost aplicată, iar versiunea migrației a fost înregistrată.

Rezultatul verificat: **șase tabele** — conversații, intrări de memorie, stare de agent, misiuni, evenimente de audit, versiuni de schemă. Toți cei opt indici pe tabelul de audit, inclusiv cei doi indici parțiali, pentru amprenta de lanț și pentru cosemnătura umană obligatorie. Securitate pe rând activă pe cele cinci tabele de date.

O constatare de conformitate rămâne deschisă și nereparată: vocabularul închis al tipurilor de evenimente de audit admite unsprezece valori și **nu conține** carantină, blocare pe contradicție, sau materialitate. Acestea sunt exact lipsurile semnalate în analiza de conformitate față de canonul constituțional. Orice eveniment de guvernanță din acele categorii nu are unde să fie consemnat cu numele lui propriu.

### 2.2 Interfața de date suverană

A fost ridicat un strat de acces relațional propriu, în locul dependenței de serviciul găzduit extern:

| Componentă | Rol |
|---|---|
| Container de interogare relațională | Expune schema `ronor` prin protocol de reprezentare a stării, pe rețeaua internă de guvernanță |
| Container de rescriere a căilor | Traduce prefixul de cale așteptat de adaptorul existent către rădăcina interfeței, pe două rețele interne |
| Rol de autentificare | Cu drept de conectare, fără moștenire, membru al rolului de serviciu |
| Rol de serviciu | Fără drept de conectare, cu ocolirea securității pe rând — reproduce semantica platformei înlocuite |
| Jeton de serviciu | Semnătură simetrică, revendicare de rol, emitent propriu, valabilitate de trei ani |

Toate acreditările au fost generate în mediul serverului și nu au fost afișate. Se confirmă doar lungimea și amprenta trunchiată.

**Proba cap-coadă, executată din interiorul containerului de guvernanță:** scrierea unui eveniment de audit real a returnat cod de creare, cu identificator generat de bază; citirea a returnat rândul; cererea fără acreditare a fost respinsă explicit cu „accesul anonim este dezactivat"; rândul a fost confirmat în baza reală și apoi șters. O primă încercare fusese respinsă de securitatea pe rând, fiindcă migrația crease politică pentru un singur tabel — de aici necesitatea ocolirii la nivel de rol de serviciu.

**Expunere verificată:** niciunul dintre cele două containere nu publică porturi pe gazdă. Sondarea din gazda primară către gazda secundară arată portul interfeței filtrat, împreună cu portul bazei de date și portul serviciului. Nicio suprafață publică nouă.

### 2.3 Relegarea și recrearea serviciului de guvernanță

Fișierul declarativ de compunere a fost verificat ca fidel containerului viu înainte de recreare: aceeași imagine, aceeași comandă, toate cele cinci montări de volume, aceleași două rețele, aceeași verificare de sănătate. O singură diferență de mediu a fost găsită — cheia administrativă, unde valoarea vie era o rotație pregătită anterior și niciodată aplicată în fișier. S-a verificat că niciun alt container nu folosea vreuna dintre valori, iar cea nouă era deja consemnată pe gazdă. Recrearea a fost, deci, sigură.

Modificările în fișierul de mediu, cu copie de siguranță datată: adresa interfeței de date către noul container intern; jetonul de serviciu; schema. Steagul care face persistența obligatorie a fost **lăsat deliberat neschimbat**, pentru a nu transforma un eșec de scriere în refuz de cerere înainte ca scrierile să fie probate în producție.

Serviciul a fost recreat și a revenit sănătos, cu nouă furnizori de model activi și șapte invocabili.

### 2.4 Verificarea cap-coadă cu o cerere reală

O cerere reală a fost trimisă către punctul de interogare al runtime-ului, cu cheia administrativă activă. Rezultatul măsurat, nu presupus:

- Cererea a reușit. Răspunsul a fost produs de un model suveran găzduit local, prin transport nativ, deci **fără cost extern**.
- Porțile de guvernanță au funcționat: verdictul a fost **escaladare**, cu două constatări care nu permiteau trecerea, și s-a deschis automat o **contestație** legată de porțile cinci și șase.
- Lanțul local de audit a scris două verigi noi, cu amprentă înlănțuită corectă.
- Registrul local de lucru a înregistrat cererea cu model, transport, latență și verdict.
- Tabelul de evenimente de audit din baza de guvernanță a rămas la **zero rânduri**.

Ultimul punct este dovada finală că problema rămasă era în cod, nu în infrastructură. Calea de scriere fusese probată funcțională cu câteva minute înainte, din același container. Serviciul pur și simplu nu o folosea.

Două observații de calitate, colaterale, care merită atenție separată: latența răspunsului a fost de aproximativ optzeci și opt de secunde pentru o întrebare trivială, iar o întrebare complet benignă a produs verdict de escaladare. Prima sugerează o problemă de dimensionare a modelului suveran față de sarcină. A doua sugerează porți calibrate prea strict, care vor genera contestații pentru trafic normal și vor obosi cosemnatarul uman până la ignorare — un mod clasic de eșec al guvernanței prin exces de alarmă.

### 2.5 Legarea în cod — cererea de integrare 30

Punctul de legare a fost ales acolo unde trece fiecare verigă, fără excepție: funcția care adaugă o verigă în lanțul local. Oglindirea pornește imediat după inserarea locală reușită și înainte de returnarea verigii.

Reguli de proiectare respectate în implementare, verificate personal în diferență:

- **Lanțul local rămâne autoritar.** Oglindirea nu așteaptă, nu blochează și nu poate arunca. Comentariul din cod explică de ce bariera suplimentară nu e redundantă: o excepție în acel punct ar pierde o verigă deja scrisă.
- **Vocabularul închis este respectat prin traducere explicită.** Fiecare tip de decizie din lanțul local este tradus într-una din cele unsprezece valori admise, cu tipul original păstrat în sarcina utilă atunci când nu există corespondent. Fără această traducere, fiecare rând ar fi fost respins de constrângerea bazei.
- **Amprenta de lanț este transmisă neschimbată** în câmpul prevăzut pentru ea de migrație, care îl descrie drept cheie de reconciliere. Cele două registre devin astfel verificabile unul față de celălalt.
- **Cosemnătura umană obligatorie** este marcată pentru verdictele de escaladare și de refuz.
- **Sănătatea devine onestă.** Persistență configurată dar inaccesibilă înseamnă stare degradată, cu motiv explicit, pe ambele căi de sănătate. Verificarea de sănătate a containerului a fost lăsată neschimbată deliberat, ca degradarea să nu repornească în buclă un serviciu care răspunde corect — degradarea se citește din corpul răspunsului, nu din codul de stare.

Nouă fișiere, aproximativ o mie de linii adăugate, treizeci și nouă de cazuri de test noi. Cele șase verificări obligatorii trecute, verificate independent de mine prin interogarea directă a stării verificărilor pe amprenta de vârf a ramurii. Ramura `main` a rămas la aceeași amprentă ca înainte.

Un compromis din această lucrare cere decizie umană explicită: amprenta fixată a fișierului lanțului de audit s-a schimbat inevitabil prin legare, iar fixarea a fost mutată în cele trei porți care o verifică, cu justificare scrisă lângă valoare. De asemenea, o condiție de echivalență a fost reformulată, fiindcă raportarea onestă a persistenței face starea „degradată" corectă într-un mediu de verificare fără bază de guvernanță. Ambele sunt modificări ale mecanismului de control, deci nu ar trebui integrate fără citire deliberată.

### 2.6 Rotația cheii de acces la baza de cunoștințe

Cheia rădăcină cu drepturi complete de citire, scriere și administrare, folosită pentru peste șase mii de apeluri, a fost dezactivată durabil — s-a verificat în cod că procedura de asigurare a cheii rădăcină nu reactivează un rând existent, deci dezactivarea nu se anulează la repornire. A fost emisă o cheie nouă, limitată la citire, cu limită de ritm și dată de expirare. O adresă de conectare greșită, care ar fi rupt fluxul de raportare, a fost corectată.

### 2.7 Alarma de acces

Detectorul de acces din origine necunoscută rulează pe ambele gazde, la interval de un sfert de oră, cu linie de bază de origini cunoscute, jurnal de alarmă și arhivă a liniilor deja raportate. Sarcina programată de observare citește ambele gazde și raportează doar la noutate.

Prima raportare reală a alarmei a semnalat două autentificări din origine necunoscută. Ambele erau **propriile mele conexiuni** din această sesiune, de la adresa de ieșire a spațiului de lucru. Alarma a funcționat corect. Adresa nu e stabilă între sesiuni, deci se va repeta la fiecare intervenție de la spațiul de lucru — un zgomot cunoscut, care trebuie fie adăugat la linia de bază, fie acceptat ca semnal așteptat.

## 3. Ce urmează

### 3.1 Poarta imediată — decizia umană de integrare

Cererea de integrare 30 este completă, verde și deschisă. Nimic din lucrarea de cod nu produce efect până la integrare și desfășurare. Recomandarea mea este integrarea, cu citirea deliberată a celor două modificări ale mecanismului de control descrise mai sus.

După desfășurare, măsurarea obligatorie: o cerere reală trebuie să producă un rând în tabelul de evenimente de audit al bazei de guvernanță, cu amprentă de lanț identică verigii locale corespunzătoare. Până la acea măsurare, legarea rămâne o afirmație despre cod, nu un fapt despre sistem.

### 3.2 Poarta următoare — persistența devine obligatorie

Steagul care face persistența obligatorie trebuie ridicat **numai după** ce oglindirea a fost măsurată funcțională în producție. Ridicat prematur, transformă fiecare defect de rețea într-un refuz de cerere. Ridicat la momentul corect, elimină definitiv posibilitatea unei scrieri de audit pierdute în silențiu — care este exact defectul care a permis situația de față.

### 3.3 Igienă de acreditări — cere acordul dumneavoastră

Trebuie consemnat ca greșeală proprie: într-o etapă anterioară am afișat valoarea parolei bazei de guvernanță într-o ieșire de inspecție, încălcând regula care interzice afișarea secretelor. Parola trebuie considerată expusă și rotită. Rotația cere recrearea a patru containere — baza de guvernanță, serviciul de guvernanță, și cele două componente ale bazei de cunoștințe — deci cere acordul dumneavoastră separat, fiindcă întrerupe serviciul pentru durata recreării.

În aceeași operațiune se curăță și trei valori moarte sau periculoase din mediu: adresa de conectare directă la bază, care nu se rezolvă din rețelele serviciului; adresa bazei găzduite externe, care trebuie golită ca să nu existe cale de întoarcere accidentală; și o valoare moartă din fișierul de mediu al bazei de cunoștințe.

### 3.4 Conformitate față de canon — vocabularul de audit

Extinderea vocabularului închis al tipurilor de evenimente cu carantină, blocare pe contradicție și materialitate. Este o migrație de schemă și o modificare de cod, deci un ciclu complet de ramură, verificări și integrare umană. Recomand să urmeze imediat după poarta 3.2, ca traducerea implementată acum să nu ascundă permanent categorii de evenimente sub eticheta generică.

### 3.5 Calibrarea porților și dimensionarea modelului

Cele două observații din verificarea cap-coadă merită lucrare separată. Escaladarea unei întrebări benigne și optzeci și opt de secunde de latență pentru o sarcină trivială sunt, împreună, o combinație care face sistemul greu de folosit în regim normal. Recomand măsurarea pe un set de cereri reprezentative înainte de orice ajustare, ca schimbarea să nu fie ghicită.

### 3.6 Rămâne strict la dumneavoastră

Retragerea autorizațiilor agentului secundar din consolele terților — poștă, depozit de cod, bază găzduită, identitate corporativă. Este imposibil de executat din spațiul de lucru, fiindcă regula privind accesul la consolele de furnizor de la adresa dumneavoastră actuală o interzice. Aceasta rămâne singura sarcină din întregul plan care nu poate fi automatizată și care închide expunerea cea mai largă.

## 4. Regimul respectat

Nicio integrare, nicio publicare pe ramura principală, nicio lansare și nicio desfășurare nu au fost efectuate. Nicio valoare de secret nu a fost afișată în această etapă. Consolele de furnizor nu au fost accesate. Nimic nu a fost instalat pe laptop. Călirea generală a accesului prin consolă la distanță rămâne neautorizată și neatinsă.
