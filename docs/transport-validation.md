# Validarea transportului

Această procedură verifică, printr-o singură rulare de dezvoltare mărginită, că
suita de regresie a transportului și izolarea bazei de date de audit persistente
sunt prezente și trec. Este o operațiune de control, nu o cale generală de a
trimite sarcini autorului: obiectivul este fixat în scriptul care o pornește și
nu poate fi înlocuit din linia de comandă.

## Ce anume se validează

| Suită | Ce apără |
| --- | --- |
| `tests/runtime/automation-http-transport.test.ts` | adaptorul HTTP nu mai moștenește așteptarea implicită a lui `fetch`; termenul este al nostru, nu al platformei |
| `tests/runtime/development-controller.test.ts` | baza de date de audit persistentă este izolată între rulări |
| `tests/runtime/automation-run-lease.test.ts` | arendarea unei rulări nu se suprapune peste o alta prin aceeași bază de date |

Cele trei fișiere au fost instalate printr-un commit local asistat de operator.
Obiectivul spune explicit autorului să nu pretindă că le-a scris și să nu le
dubleze.

## Unelte

Ambele scripturi rulează **în containerul controlorului de dezvoltare**, unde
există `/app/scripts/ronor-develop.mjs` și fișierul cu cheia de arhitect. Ambele
sunt și module importabile, astfel încât contractul lor este verificat de
`tests/cli/ronor-transport-validation.test.cjs` fără rețea și fără model.

Ambele scripturi sunt copiate în imaginea controlorului de
`Dockerfile.development-tools`, alături de `ronor-develop.mjs`; o unealtă care
nu este listată acolo nu ajunge în container, oricât de corect ar fi commit-ul.

### `scripts/ronor-transport-validation-run.cjs`

Pornește exact o rulare de dezvoltare cu obiectivul fixat.

| Argument | Obligatoriu | Implicit | Plafon |
| --- | --- | --- | --- |
| `--approved-validation` | da | — | — |
| `--id=<identificator>` | da | — | `^[a-z0-9][a-z0-9-]{7,63}$` |
| `--suite=<suită>` | nu | `transport` | `transport`, `controller`, `lease`, `all` |
| `--max-cost-usd=<n>` | nu | 100 | 100 dolari SUA |
| `--max-runtime-minutes=<n>` | nu | 15 | 15 minute |
| `--dry-run` | nu | absent | — |

Ciclurile de reparație sunt fixate la unul singur și nu pot fi mărite.

O validare acoperă, implicit, o singură suită. Motivul este măsurat, nu teoretic:
la 16 septembrie 2026, o rulare peste toate trei suitele a epuizat plafonul de 15
minute după o însărcinare din trei, cu numai 12,38 dolari SUA cheltuiți din 25
autorizați, deci plafonul care a mușcat a fost cel de timp. Cele trei valori
`transport`, `controller` și `lease` corespund celor trei fișiere din tabelul de
mai sus; obiectivul trimis numește atunci doar suita aleasă și doar comanda care
o rulează. Valoarea `all` păstrează mandatul combinat disponibil, dar nu încape
în plafonul de durată și nu trebuie folosită fără o ridicare deliberată a
acestuia. O suită necunoscută este refuzată cu `validation_suite_invalid`.

Refuzurile sunt coduri, nu texte libere: `validation_not_approved`,
`validation_id_missing`, `validation_id_invalid`, `validation_cost_invalid`,
`validation_runtime_invalid`, `validation_argument_unknown`,
`architect_key_file_missing`, `request_path_unwritable`. Refuzul se scrie la
ieșirea de eroare ca obiect JSON și lasă codul de ieșire `1`. Nimic nu se
pornește la un refuz.

`--dry-run` tipărește cererea exactă care ar fi trimisă, cu
`no_model_started: true` și `no_run_created: true`. Este calea acceptată de a
demonstra uneltele pe o gazdă fără a consuma credit de model.

Probă, fără cost:

```
docker exec \
  -e RONOR_ARCHITECT_API_KEY_FILE=/run/secrets/development_architect_key \
  ronor-development-controller \
  node /app/scripts/ronor-transport-validation-run.cjs \
    --approved-validation --id=transport-validation-20260915 --dry-run
```

Rulare reală, care consumă credit de model și trebuie autorizată explicit
înainte:

```
docker exec \
  -e RONOR_ARCHITECT_API_KEY_FILE=/run/secrets/development_architect_key \
  ronor-development-controller \
  node /app/scripts/ronor-transport-validation-run.cjs \
    --approved-validation --id=transport-validation-20260916a \
    --suite=transport --max-cost-usd=25
```

Cererea este scrisă cu drepturi numai pentru proprietar (`0600`), în primul loc
scriibil din `/tmp/ronor-transport-request.json` și
`/app/data/ronor-transport-request.json`.

### `scripts/ronor-transport-validation-status.cjs`

Urmărește rularea, strict în citire.

| Argument | Obligatoriu | Implicit | Plafon |
| --- | --- | --- | --- |
| `--run=run_<hex>` | da | — | — |
| `--mission=msn_<identificator>` | da | — | — |
| `--watch-seconds=<n>` | nu | 240 | 900 |
| `--interval-seconds=<n>` | nu | 15 | 120 |

Identificatorii sunt obligatorii tocmai pentru ca un identificator vechi să nu
poată fi urmărit din obișnuință. Refuzuri: `status_run_missing`,
`status_run_invalid`, `status_mission_missing`, `status_mission_invalid`,
`status_watch_invalid`, `status_interval_invalid`, `status_argument_unknown`,
`architect_key_file_missing`.

Se tipărește o linie JSON doar când starea observată se schimbă, cu exact aceste
câmpuri: `at`, `run_id`, `mission_id`, `status`, `reason_code`, `attempt_count`,
`last_error`, `cost_usd`, `progress`. Obiectivele, transcrierile, probele și
acreditările nu sunt tipărite niciodată. Urmărirea se oprește la o stare
terminală (`failed`, `succeeded`, `cancelled`, `interrupted`, `complete`) sau la
expirarea bugetului de urmărire, fără repornire automată.

```
docker exec \
  -e RONOR_ARCHITECT_API_KEY_FILE=/run/secrets/development_architect_key \
  ronor-development-controller \
  node /app/scripts/ronor-transport-validation-status.cjs \
    --run=run_006cc7aa5f89f370b94b --mission=msn_mtt6t4q8_1304ee6c --watch-seconds=600
```

## Ordinea de operare

1. Rulează scriptul cu `--dry-run` și citește cererea tipărită. Dacă obiectivul
   sau plafoanele nu sunt cele dorite, oprește-te aici: ele nu se schimbă din
   linia de comandă, ci prin modificarea scriptului și o revizie nouă.
2. Obține autorizarea explicită pentru o rulare care consumă credit de model.
3. Pornește rularea cu un identificator nou. Un identificator refolosit este
   respins de controlor, nu de acest script.
4. Urmărește rularea cu scriptul de stare, folosind identificatorii întorși la
   pornire.
5. La o stare terminală, citește rezultatul și probele prin `ronor-develop.mjs`.
   Acest script nu interpretează verdictul.

## Admiterea unui cap de dezvoltare verificat de operator

Commit-ul care a instalat cele trei suite a fost scris local, nu de autor, deci a
trebuit admis explicit pe gazdă. Cele două scripturi de admitere de unică
folosință, `scripts/admit-isolated-tests-head.sh` și
`scripts/admit-recovered-development-head.sh`, aveau capetele fixate în cod și se
deosebeau doar prin mesaje; ele au fost înlocuite de un singur script cu
parametri, `scripts/admit-development-head.sh`:

```
bash scripts/admit-development-head.sh --approved-admission <cap-nou> <cap-vechi>
```

Ambele capete se dau ca sume de patruzeci de cifre hexazecimale, scriptul rulează
ca root pe gazdă și refuză cu codul de ieșire `2` orice altă formă. Admiterea
păstrează egalitatea strictă: schimbă doar capul așteptat, verifică înainte și
după starea controlorului, cere ca suma de control a registrului de buget să fie
neschimbată și lasă celelalte șase containere neatinse.

## Delimitări

- Scripturile nu integrează, nu publică, nu lansează și nu repornesc containere.
  Autorul primește interdicția explicită în obiectiv, iar porțile independente
  de verificare și de asigurare rămân singura cale de acceptare.
- Plafonul de 100 de dolari SUA este un plafon de refuz, nu o intenție de
  cheltuială. Coboară-l cu `--max-cost-usd` la valoarea potrivită mandatului.
- Fiecare rulare plătește din nou inspecția inițială a depozitului, deci trei
  rulări pe câte o suită costă mai mult, cumulat, decât una singură care ar
  încăpea în timp. Se preferă totuși, pentru că nu slăbește niciun plafon de
  siguranță și pentru că izolează suita care cade.
- Aceste unelte cer o rulare de dezvoltare completă, cu autor. Ele nu se
  confundă cu `verify-existing`, descrisă în `docs/verify-existing-commit.md`,
  care verifică un interval de commit-uri fără autor.
- Contractul de argumente și redactarea ieșirii sunt acoperite de teste. Ce nu
  este acoperit local este comportamentul controlorului însuși, care are propria
  suită.
