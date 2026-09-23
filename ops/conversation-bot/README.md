# Candidat de remediere al botului conversațional

Cod derivat din exportul redactat al botului verificat la 23 septembrie 2026.
Nu reprezintă o instalare și nu include valori de credențiale.

## Schimbări de siguranță

- Interfața modelului admite numai `query_cida` și `reply_to_merlin`, pentru
  conversația autorizată. Comenzile administrative, accesul la gazda de modele,
  e-mailul, accesul web arbitrar și delegarea către agenții externi sunt refuzate.
- Recepția mesajelor este separată de execuție. SQLite persistă fiecare mesaj
  înainte de avansarea cursorului Telegram; cheia unică este identificatorul
  actualizării. O sarcină întreruptă de căderea procesului nu se reia automat.
- `/stop` întrerupe sarcina asincronă și anulează mesajele încă neexecutate.
  Nu anulează retroactiv cereri acceptate de servicii externe și nici cheltuieli.
- Erorile de citire și scriere ale memoriei sunt separate. Rezultatele regăsite
  sunt date neîncrezute, nu instrucțiuni de sistem.
- Rezultatul unei comenzi de diagnostic include cod de ieșire, expirarea
  duratei, ieșiri separate, trunchiere, durată și identificator.
- Trimiterea Telegram trebuie confirmată de serviciu; un eșec nu este succes.

## Condiții înaintea instalării

1. Compararea copiei instalate cu amprenta exportului auditat și reconcilierea
   oricărei modificări intervenite.
2. Lotul tranzitoriu aprobat reutilizează acreditările existente exclusiv în
   releul separat, într-un fișier privat. Botul primește numai aliasuri fără
   valoare de autentificare. Rotația acreditărilor expuse rămâne obligatorie
   pentru închiderea auditului, dar nu este inclusă în acest lot.
3. Container fără socket Docker, fără binarul Docker și fără directoare SSH.
   Utilizator neprivilegiat, sistem de fișiere numai pentru citire, director
   separat și privat pentru `/var/lib/ronor-bot`.
4. Botul are `network_mode: none`; toate cererile trec prin socketul Unix al
   releului. Releul limitează strict metoda, destinația, calea și conversația.
   Limita de ieșire per apel nu reprezintă un plafon financiar agregat.
5. Probă de recepție, refuz, STOP și recuperare după repornire pe instalarea exactă.

Rutinele istorice rămase în fișier nu sunt o interfață autorizată și nu trebuie
expuse. Punctul de intrare este noul `main()`. Comenzile administrative nu se
reactivează printr-o variabilă de mediu; ele necesită integrarea unui executor
extern care verifică mandatul la fiecare efect.

Acest candidat asigură restricționare, nu închiderea integrală a constatării F01.
Revocarea semantică a memoriei, confirmarea persistenței per înregistrare și
reluarea idempotentă după erori de scriere rămân porți separate.

## Instalare controlată

`prepare_host.py` extrage fără afișare valorile existente și conservă originalele
numai pe gazdă. Nu reexecută codul original pentru extragerea cheilor.
`compose.yaml` nu publică porturi și nu repornește CIDA sau memoria.
`probe_isolation.py` verifică numai citiri și refuzuri: nu trimite mesaje, nu
apelează modelul și nu scrie în memorie. Cheia CIDA configurată pe gazdă a fost
observată dezactivată; releul nu o preia și refuză căutarea până la autorizarea
separată a unei chei numai pentru citire. `/health` nu dovedește căutare autorizată.

Vechiul container se conservă oprit, cu repornirea automată dezactivată.
Actualizările Telegram încă neconfirmate la transfer se păstrează local ca
`interrupted`, fără reluare automată. Un rezultat extern incert cere verificare
umană, nu retrimitere. Nu există rollback automat către botul privilegiat.
