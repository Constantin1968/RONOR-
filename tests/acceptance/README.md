# Suita de acceptare externă (M1)

Acest director e protejat de poarta de acceptare din `src/runtime/automation/acceptance-gate.ts`.
O rulare a buclei de dezvoltare care modifică, adaugă sau șterge ceva aici, în `.github/`,
în `src/runtime/automation/` sau în configurarea testelor e respinsă, indiferent dacă testele trec.

Suita se schimbă numai printr-o cerere de integrare separată, aprobată de om, niciodată de agent.

Activare pe gazdă (colectorul de probe):

- `RONOR_ACCEPTANCE_RECEIPT_ROOT` — director în afara spațiului de lucru pentru chitanțe;
- `RONOR_AUTOMATION_EXPECTED_HEAD` — commit-ul de bază fixat (40 de caractere);
- în `RONOR_AUTOMATION_TEST_COMMANDS_JSON` o comandă cu `id` = `acceptance` care rulează `jest tests/acceptance`;
- opțional `RONOR_ACCEPTANCE_PROTECTED_PATHS_JSON`, listă de căi protejate suplimentare.

Fără oricare dintre cele obligatorii, colectorul refuză să pornească.
