# Bugetul apelurilor de model

## Ce controlează implementarea

- Controlerul semnează identitatea execuției, misiunea, rolul, plafonul, consumul anterior, expirarea și versiunea tarifelor. Bridge-ul verifică legătura cu misiunea și termenul capabilității de execuție.
- Proxy-ul de producție refuză apelurile facturabile fără autorizație bugetară. Autorizația internă nu este trimisă furnizorului.
- Rezervarea este scrisă tranzacțional în SQLite, cu WAL și sincronizare FULL, înainte de apelul HTTP. Autorul și verificatorul folosesc același registru de execuție.
- Un apel concurent, o autorizare veche sau un restart nu eliberează rezervarea și nu resetează consumul. Un răspuns fără usage ori o întrerupere cu rezultat necunoscut blochează continuarea.
- Usage valid este contabilizat în microdolari întregi. Depășirea rezervării este păstrată integral și blochează execuția, nu este ascunsă prin rotunjire la plafon.
- Intrările admise sunt text și funcții locale. Sunt refuzate streamingul, contextul extern implicit, imaginile, instrumentele facturabile externe și modelele fără tarife aprobate. Ieșirea este limitată în cerere.
- Timeout-ul upstream nu trece de expirarea autorizării. Deconectarea clientului anulează cererea locală, fără să presupună că furnizorul nu mai poate factura un apel deja primit.

## Limite pe care nu le ascundem

Rezervarea pentru intrare este conservatoare: octeții JSON plus o marjă pentru formatarea mesajelor și instrumentelor. Nu este o tokenizare exactă certificată de furnizor, deci nu constituie o garanție necondiționată asupra facturii. Un plafon financiar impus în contul furnizorului sau o metodă de numărare garantată de acesta rămâne necesar pentru acea garanție.

Proxy-ul se bazează pe respectarea parametrului de ieșire și pe usage furnizat de serviciul upstream. Orice depășire detectată îngheață bugetul; nu poate anula retroactiv un cost deja produs.

Un restart al controlerului nu are voie să schimbe identitatea bugetului unei reluări. Reconcilierea unei execuții vechi și reautorizarea unui mandat expirat sunt operații distincte, care nu sunt realizate de instalatorul acestui control.

## Baza contabilă

Pentru ruta internațională DashScope și Qwen3.8 Max, politica utilizează tariful standard de 2 USD per milion de tokeni de intrare și 6 USD per milion de tokeni de ieșire, fără a credita reducerile de cache sau promoțiile ([Alibaba Cloud, Qwen3.8 Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max)).

Acest subtotal de catalog este un calcul conservator din usage, nu factura efectivă. Tokenii citiți din cache, dacă sunt incluși în tokenii de intrare, nu se adună a doua oară; documentația distinge prețurile și condițiile aplicabile cache-ului și cotelor gratuite ([Alibaba Cloud, prețurile modelelor](https://www.alibabacloud.com/help/en/model-studio/model-pricing)).

## Instalare și păstrarea stării

Suprapunerea bugetară se adaugă ultima peste fișierele Compose existente. Ea înlocuiește exclusiv controller, OpenHands bridge, codex-verifier și model-egress-proxy.

Registrul persistent este în `/srv/ronor/development-automation/model-budget/ledger.db`. Directorul are proprietar 10001:10001 și mod 0700; nu conține chei de furnizor. Instalatorul nu lansează modele, nu reia sarcini, nu reînnoiește mandate, nu șterge patch-uri și nu schimbă celelalte patru containere.

Validarea locală și verificarea containerelelor nu demonstrează autonomie cap-coadă. Proba de întrerupere, reluare, verificare independentă și acceptare rămâne o poartă separată.
