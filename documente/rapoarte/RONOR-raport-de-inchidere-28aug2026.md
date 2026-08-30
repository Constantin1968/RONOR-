# RONOR — Raport de închidere, 28 august 2026

Patru porți au fost deschise și închise. Documentul spune ce s-a făcut, ce dovadă
există pentru fiecare afirmație, și ce urmează până la ținta finală.

---

## Partea I — Ce s-a făcut

### Poarta 1 — Accesul extern, revocat

Cheile de agent extern nu mai au acces la nicio gazdă.

| Gazdă | Cheie eliminată | Ce a rămas |
| --- | --- | --- |
| Secundară (Hetzner) | `archeon-sandbox-2026`, amprentă `SHA256:gPJq/qA2aUR5NEqTd92Lp3CbyCMYgSi8jzzupEaxA+c` | numai `ronor-do-primary` |
| Primară (DigitalOcean) | `ronor-archeon-sandbox`, amprentă `SHA256:dYGINfxwQtuu5EeqBC0xNBOYqQUX1NuAqdkcoeZL4Hg` | numai `ronor-backup@ronor-secondary` |

Copii de siguranță: `authorized_keys.inainte-revocare-archeon-28aug2026`, pe ambele gazde.
Accesul a fost confirmat pe conexiuni noi după revocare. Serviciul `sshd` nu a fost atins.
Drepturile fișierului `.orch_env.json` au fost strânse de la `644` la `600`.

### Poarta 2 — Copia de rezervă, dusă în afara gazdei și dovedită

**Copia în afara gazdei.** Scriptul `/usr/local/sbin/trage-cida-de-pe-hetzner.sh` rulează
zilnic pe gazda primară și trage de pe secundară: cinci descărcări de baze de date,
şapte instantanee vectoriale, arhiva de cod, configuraţia frontală. **476 MB, fiecare
fişier verificat prin `sha256` ca identic cu sursa.** Arhivele de secrete nu sunt
replicate niciodată — scriptul verifică explicit că numărul lor este zero şi eşuează altfel.

**Un decalaj de versiune, rezolvat.** Utilitarul de restaurare de pe gazda primară este
versiunea 16.14 şi nu poate citi descărcările produse de versiunea 17.10 de pe secundară.
Validarea rulează acum într-un container cu versiunea corectă. Nimic nu a fost instalat
în sistemul gazdei. Scriptul eşuează dacă găseşte mai puţin de cincisprezece tabele cu
date sau dacă vreun instantaneu vectorial nu se citeşte ca arhivă.

**Restaurarea, dovedită pe date reale.** Descărcarea bazei principale a fost restaurată
într-o bază de unică folosinţă şi numărată rând cu rând faţă de producţie. Identice pe
unsprezece tabele. Pe cinci tabele producţia este mai mare exact cu ingestia petrecută
între momentul copiei şi momentul verificării. Producţia nu a fost atinsă.

**O afirmaţie anterioară, retrasă.** Susţinerea că proba de restaurare nu rulase niciodată
era **greşită**. Rulează duminical şi scrie în rapoarte separate, nu în jurnalul comun.
Două rapoarte consecutive arată trecere completă. Ce lipsea cu adevărat era proba de
restaurare cu numărare de rânduri pe baza relaţională — aceasta s-a făcut acum.

### Poarta 3 — Defectul din copia de rezervă şi sedimentul

**Eticheta `[parţial]` era falsă.** `tar` iese cu cod `1` pentru „file changed as we read it",
normal pe un arbore viu. Verificarea definitivă, cu `--quoting-style=literal`, arată
**lipsă reală: zero**. Cele şaisprezece fişiere absente sunt exclusările intenţionate.

„Douăzeci şi unu de fişiere lipsă", din raportul anterior, era **un artefact de comparaţie**:
listarea implicită a lui `tar` escapează diacriticele în octal, deci comparaţia nu potrivea
niciun nume românesc. Retrag afirmaţia.

Verdictul se dă acum pe două condiţii simultane — cod de ieşire `≤ 1` **şi** cel puţin
două mii de fişiere în arhiva rezultată — altfel raportează `[EŞEC]` cu codul şi numărul efectiv.

**Sedimentul, arhivat reversibil.** Patruzeci şi şapte de fişiere de unică folosinţă —
corecţii, diagnostice, umbre `.bak` şi `.pre_*`, o arhivă duplicat de 178 MB.

Ordinea verificărilor a fost deliberată: **întâi** s-a dovedit că niciunul nu este apelat
de crontab, de systemd, de containere sau de vreunul din cele două sute cincizeci şi două
de scripturi active — zero referinţe; **apoi** s-a făcut un instantaneu în depozitul local;
**apoi** arhiva; **apoi** fiecare fişier a fost verificat prin `sha256` faţă de original;
**abia apoi** ştergerea. Trei straturi de reversibilitate înaintea unei singure ştergeri.

Rezultat: rădăcina a scăzut de la 153 la 111 fişiere, dimensiunea de la 428 la 249 MB.
Lanţul apelat de crontab a fost verificat intact după curăţare — toate fişierele prezente,
sintaxă validă, module compilează.

Arhiva de sediment se afla într-un loc pe care copia zilnică nu îl acoperea. A fost dusă
în afara gazdei, verificată identică, şi **inclusă în copia zilnică**, ca să nu rămână un
capăt liber.

### Poarta 4 — Scripturile de producţie, sub control de versiune

Cele opt fişiere pe care crontabul le apelează efectiv existau numai pe disc, într-un
depozit local fără telecomandă. Sunt acum în cererea de fuziune
[numărul 29](https://github.com/Constantin1968/RONOR-/pull/29), sub `ops/hetzner/`.

Triaj de credenţiale înainte de ridicare: **curat**. Niciun secret scris direct; totul
prin variabile de mediu sau prin `.report_env`, care rămâne exclusiv pe gazdă, cu
drepturi `600`, nereplicat.

`raportare/trimite.py` de pe gazdă s-a dovedit identic cu cel deja versionat, deci nu a
fost duplicat. Confirmă provenienţa dosarului `raportare/` din acest repozitoriu.

**Fuzionată, cu acordul tău explicit, cerut în momentul fuziunii.** Squash, istoric liniar,
ramura de lucru ştearsă. `main` a trecut de la `82c030c8` la `0305d90b`. Protecţia ramurii
a rămas intactă după fuziune: `strict = true` şi toate şase contextele obligatorii prezente.

**Verificarea de fidelitate, după fuziune.** Cele opt fişiere de pe `main` au fost comparate
prin `sha256` cu cele care rulează pe gazdă: **opt din opt identice, zero nepotriviri.**
Repozitoriul nu este o aproximaţie a producţiei; este copia ei exactă. De aici înainte,
orice divergenţă între gazdă şi `main` este o schimbare făcută pe loc, şi se poate detecta.

### O notă despre canalul de transfer

Releul prin laptop nu poate scrie în profilul utilizatorului şi a expirat repetat la o
sută douăzeci de secunde. Prima reasamblare a pachetului a dat sumă greşită. Am refuzat
să folosesc un pachet neverificat. Soluţia a fost amprentarea pe blocuri de o mie de
caractere: **un singur bloc din douăzeci şi unu era stricat**, a fost cerut din nou, iar
pachetul final are suma `sha256` identică cu originalul de pe gazdă. Nimic nu a intrat în
repozitoriu fără dovadă de identitate.

---

## Partea II — Ce urmează, pe porţi de dependenţă

Ordinea nu este cronologică. Fiecare poartă depinde de închiderea celei dinainte.

### Poarta 5 — Desfăşurarea din repozitoriu

**Prima jumătate este închisă.** Cererea 29 a fost fuzionată şi `main` s-a dovedit identic
cu producţia. Depozitul local de pe gazdă, fără telecomandă, şi-a pierdut rolul de unică sursă.

**A doua jumătate aşteaptă o cerere separată.** Ca scripturile să fie efectiv desfăşurate
din repozitoriu — şi nu doar oglindite în el — gazda trebuie să tragă din `main` în loc să
fie editată pe loc. Aceasta este o desfăşurare, deci o poartă distinctă, care cere acordul
ei proprie. Până atunci, repozitoriul este sursa canonică declarată, iar orice editare pe
loc devine o divergenţă detectabilă prin compararea amprentelor. Aceasta închide cauza
structurală a sedimentului, nu doar efectul.

### Poarta 6 — Suprafaţa expusă

**Neautorizat. Aşteaptă hotărârea ta**, amânată cu „nimic acum, verific întâi regulile".

Măsurat: autentificare cu parolă activă, utilizatorul de serviciu are parolă utilizabilă,
apărarea împotriva încercărilor repetate este inactivă, nicio regulă de limitare pe
firewall, treizeci şi şapte de mii şase sute şaptezeci şi şase de încercări de parolă
eşuate, unsprezece mii cinci sute optsprezece utilizatori inexistenţi încercaţi,
şapte porturi publice.

Există şi un serviciu separat, `/opt/ronor-cc`, de 75 MB, fără corespondent în repozitoriu,
neautentificat şi servit public. Nu l-am oprit — oprirea unui serviciu servit public este
o decizie care îţi aparţine.

### Poarta 7 — Credenţialele care trebuie schimbate din altă parte

**Depinde de tine, nu de mine.** Cheile de serviciu şi parolele aflate pe gazdă trebuie
înlocuite dintr-un punct de acces care nu este cel curent. Consolele de furnizor nu se
accesează de aici. Până la înlocuire, orice cheie care a trecut prin gazdă trebuie
considerată cunoscută.

### Poarta 8 — Dovada că sistemul reporneşte singur

Politica de repornire a containerelor este declarată, dar nedovedită. Proba cere o
repornire a gazdei, care întrerupe serviciul. **Aşteaptă acordul tău** pentru fereastra
în care întreruperea este acceptabilă.

### Poarta 9 — Privilegiile containerelor

Patru containere au acces la controlul motorului de containere, ceea ce echivalează
practic cu drepturi de administrator pe gazdă. Coborârea privilegiilor cere o probă
prealabilă că funcţionalitatea nu depinde de acel acces. **Depinde de Poarta 8** — nu se
schimbă politica de privilegii înainte de a dovedi că sistemul se ridică singur.

### Poarta 10 — Generaţia a doua

Codul din `src/runtime/` există şi este verificat în repozitoriu, dar nu rulează în
producţie. Desfăşurarea lui **depinde de Porţile 5, 8 şi 9**: nu se pune o generaţie nouă
peste o gazdă a cărei repornire nu este dovedită, cu containere supraprivilegiate, şi cu
scripturi editate pe loc în afara controlului de versiune.

### Poarta 11 — Grupul CIDA şi conţinutul de recuperat

Cele cinci containere sunt sănătoase şi neatinse. Subdomeniul pe care intenţionai să
recuperezi accesul **nu are înregistrare în sistemul de nume şi nu apare în nicio
configuraţie frontală**. Blocajul nu pare a fi credenţialele, ci absenţa înregistrării
plus absenţa unui bloc de configuraţie. Grupul este accesibil pe cale internă, deci
recuperarea conţinutului nu depinde de subdomeniu.

---

## Ţinta finală

O platformă în care fiecare fişier care rulează provine din repozitoriu, fiecare copie de
rezervă este dovedită prin restaurare, fiecare acces este nominal şi revocabil, iar
generaţia a doua rulează în producţie pe o gazdă a cărei repornire este demonstrată.

S-au închis fundaţiile: accesul revocat, copia de rezervă dovedită prin restaurare, curăţenia,
şi controlul de versiune — acesta din urmă fuzionat şi dovedit identic cu producţia.
Ce rămâne sunt decizii care îţi aparţin — suprafaţa expusă, credenţialele, fereastra de
întrerupere — şi lucrări care depind de ele.

---

*NrgPaths Advisory Ltd*
