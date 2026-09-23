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
2. Rotația credențialelor expuse și injectarea valorilor noi prin mediul procesului.
   Obligatorii: `TELEGRAM_BOT_TOKEN`, `RMEMORY_API_KEY`, `DASHSCOPE_API_KEY`.
   Celelalte modele necesită cheile proprii dacă sunt activate.
3. Container fără socket Docker, fără binarul Docker și fără directoare SSH.
   Utilizator neprivilegiat, sistem de fișiere numai pentru citire, director
   separat și privat pentru `/var/lib/ronor-bot`.
4. Politică de rețea care limitează destinațiile și plafonul de consum.
5. Probă de recepție, refuz, STOP și recuperare după repornire pe instalarea exactă.

Rutinele istorice rămase în fișier nu sunt o interfață autorizată și nu trebuie
expuse. Punctul de intrare este noul `main()`. Comenzile administrative nu se
reactivează printr-o variabilă de mediu; ele necesită integrarea unui executor
extern care verifică mandatul la fiecare efect.

Acest candidat asigură restricționare, nu închiderea integrală a constatării F01.
Revocarea semantică a memoriei, confirmarea persistenței per înregistrare și
reluarea idempotentă după erori de scriere rămân porți separate.
