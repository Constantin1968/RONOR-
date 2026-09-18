# RONOR: punctul de intrare pentru dezvoltarea automată

Această componentă leagă o sarcină de dezvoltare de executantul și verificatorii existenți. Nu înlocuiește runtime-ul operațional, nu este un dashboard și nu autorizează publicarea rezultatelor.

## Traseul implementat

`cerere → verificarea disponibilității → sarcină persistentă → mandat existent → plan → OpenHands → teste izolate → verificator → Victoria → rezultat și dovezi`

Controlerul expune numai pregătirea sarcinilor și subsetul necesar din API-ul CONTROL. Refolosește mecanismele existente pentru autentificarea arhitectului, mandat semnat, lease persistent, expirare, limite, oprire și refuzul push/merge/release/deploy.

Pregătirea sarcinii este tranzacțională. Același identificator și același obiectiv, sub aceeași identitate autentificată, returnează aceeași misiune. Un obiectiv diferit este refuzat; o misiune lipsă ori modificată nu este înlocuită pe ascuns.

## Utilizare de către operator

Clientul `scripts/ronor-develop.mjs` citește acreditarea exclusiv din fișierul indicat de `RONOR_DEVELOPMENT_API_KEY_FILE`, cu permisiuni 0600. Se conectează numai la loopback, implicit portul 3010; refuză redirecționările. Nu primește cheia în argumente.

```sh
node scripts/ronor-develop.mjs readiness
node scripts/ronor-develop.mjs start --request=cerere.json --id=identificator-stabil
node scripts/ronor-develop.mjs status --mission=msn_ID --run=run_ID
node scripts/ronor-develop.mjs cancel --mission=msn_ID --run=run_ID
```

`cerere.json` conține `objective`, `max_cost_usd`, `max_runtime_minutes` și `max_fix_cycles`. Limitele sunt explicite și apoi plafonate de politica serverului. Comanda `start` este cererea operatorului pentru executarea acestui obiectiv în limitele furnizate, nu o aprobare pentru merge sau deploy.

O eroare nu este retrimisă automat. Păstrați același identificator pentru aceeași sarcină și verificați starea înainte de o reluare. Oprirea nu promite anularea modificărilor locale deja efectuate.

## Izolare și activare

`docker-compose.development-controller.yml` este o instalație separată, opt-in. Nu se folosește ca suprascriere a runtime-ului de producție. Conectează controlerul numai la rețeaua internă existentă, publică doar `127.0.0.1:3010`, nu montează socketul Docker și nu primește chei SSH, GitHub sau ale furnizorilor de modele.

Controlerul citește worktree-ul și dovezile fără drept de scriere. Primește un director persistent propriu pentru misiunile de dezvoltare și două identități noi, distincte: arhitect și semnarea mandatelor. Acreditările serviciilor existente sunt folosite ca identități de client, fără afișare.

Se păstrează același worktree între autor și verificator. Înaintea activării trebuie verificate protocoalele autentificate, rețeaua, identitatea și starea curată a ramurii, revizia autorizată, volumele și modelele configurate. Faptul că containerele sunt `healthy` nu este suficient.

Recuperarea automată după repornire rămâne dezactivată în fișierul de instalare inițial. Activarea ei cere verificarea prealabilă a persistenței și a limitelor mandatului; nu se elimină limite pentru a forța reluarea.

## Limite care nu sunt ascunse

- Testele locale ale controlerului și clientului nu dovedesc o execuție reală prin furnizorii de modele.
- Comanda nu creează ori rotește automat worktree-uri. Politica existentă cere o ramură curată, cu origine și revizie aprobate; o ramură modificată sau nepotrivită este refuzată.
- `max_fix_cycles` limitează reluările existente; nu reprezintă încă o buclă generală de reparare semantică după orice test eșuat.
- Nu există merge automat. Rezultatul acceptat trebuie prezentat operatorului pentru integrare și publicare.
- Oprirea instalației se face numai asupra serviciului nou; baza sa de date și dovezile sunt păstrate, nu șterse. Nu se pornește ori oprește automat o execuție deja activă într-un alt serviciu.

## Verificare reproductibilă

```sh
npm run build:check
npm test -- --runInBand tests/runtime/development-controller.test.ts
node --test tests/cli/ronor-develop.test.mjs
```

Activarea în infrastructură este o operațiune separată și necesită acord explicit.

## Varianta izolată pentru worktree-ul existent necurat

`docker-compose.development-isolated.yml` pornește, separat, cele șapte servicii de execuție/verificare și controlerul. Nu modifică ori repornește containerele existente. Creează două rețele interne distincte și reutilizează numai rețeaua de ieșire restricționată a proxy-ului de modele.

Autorul și verificatorul folosesc aceeași versiune majoră Node 20 și aceleași dependențe construite din `package-lock.json` cu `npm ci`. Dependențele sunt montate separat, numai pentru citire, în ambele containere; autorul nu poate falsifica biblioteca de testare.

Directorul nou este `/srv/ronor/development-automation`. Codul de instalare, worktree-ul, dependențele, dovezile, nonces, baza de date și acreditările de serviciu au subdirectoare distincte. Acreditarea existentă a gateway-ului este reutilizată printr-o montare numai pentru citire, fără copiere sau afișare. Celelalte identități sunt nou generate numai după aprobarea instalării.

Variabilele porturilor host trebuie stabilite înainte de `config` și `up`, astfel încât porturile implicite ale instalației vechi să nu fie reutilizate: LangGraph 3324, bridge 3301, verificator 3302, Victoria 3303, controler 3010, exclusiv loopback. Evidence runner rămâne doar în rețeaua internă.
