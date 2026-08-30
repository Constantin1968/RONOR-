# `documente/` — oglinda documentară a lucrării RONOR / RSIOR

Acest director aduce sub control de versiune tot ce s-a produs în afara codului:
rapoarte, specificații, scripturi de verificare și jurnalul deciziilor.

Scopul e unul singur: **depozitul devine sursa unică de adevăr**, iar un `git pull`
aduce fidel pe orice mașină atât codul, cât și documentele care explică de ce
codul arată așa. Nu mai există artefacte care trăiesc doar într-un fir de
conversație sau într-un folder local.

RSIOR = RONOR Sovereign Intelligence Operating Runtime (runtimul suveran de
operare a inteligenței RONOR).

## Cum se folosește

Clonare, o singură dată:

```
git clone https://github.com/Constantin1968/RONOR-.git
```

Actualizare, oricând:

```
git pull
```

## Structura

### `rapoarte/`

Rapoartele de constatare, orientare, reparație, măsurare și închidere, în
ordinea în care au fost produse. Unde există pereche Word plus PDF, ambele sunt
păstrate: PDF-ul pentru citire și transmitere, Word-ul pentru intervenție.
Fișierele Markdown sunt sursa din care s-au generat celelalte două.

| Fișier | Ce conține |
| --- | --- |
| `RONOR-stadiu-real-25aug2026.md` | Prima constatare a stării reale, împotriva stării declarate |
| `RONOR-RADIOGRAFIE-EXHAUSTIVA.md` | Inventarul complet al infrastructurii și al serviciilor |
| `ronor-criminalistica-repo.md` | Analiza depozitului: istoric, porți de verificare, regresii |
| `ronor-capabilitati-runtime.md` | Capabilitățile verificate direct în `src/runtime` |
| `RONOR-infrastructura-si-capabilitati-25aug2026.md` | Infrastructura și capabilitățile, împreună |
| `RONOR-raport-de-constatare-25aug2026.md` / `.pdf` | Raportul de constatare |
| `RONOR-orientare-25aug2026.md` / `.pdf` | Raportul de orientare |
| `RONOR-plan-reparatii-25aug2026.md` / `.pdf` | Planul de reparație și finalizare |
| `RONOR-schema.pdf` | Schema de infrastructură: starea actuală, starea țintă, drumul |
| `CIDA-conformitate-canonica-25aug2026.md` | Verificarea CIDA față de canonul constituțional |
| `RONOR-raport-de-inchidere-28aug2026.md` | Raportul de închidere a etapei de reparație |
| `RONOR-masurare-insanatosire-30aug2026.md` / `.pdf` / `.docx` | Raportul de măsurare și însănătoșire |
| `RONOR-legarea-persistentei-30aug2026.md` / `.pdf` / `.docx` | Legarea persistenței suverane |

CIDA = Compliance, Intelligence, Due Diligence & Advisory — metoda de raportare
folosită pentru constatări cu valoare probatorie.

### `specificatii/`

`spec-oglindire-audit.md` — specificația după care s-a construit oglindirea
lanțului de audit în baza de guvernanță suverană.

`raport-oglindire-audit-pr30.md` — raportul de implementare al aceleiași
lucrări, cu ce s-a modificat, ce compromisuri s-au făcut și ce rămâne de
măsurat după desfășurare.

### `scripturi/generatoare-pdf/`

Generatoarele care produc rapoartele PDF: copertă, antet de secțiune, cuprins,
fonturi Carlito și DejaVu Mono, fundal fildeș. Fiecare raport are generatorul
lui, derivat din precedentul, ca stilul să rămână constant între livrări.

### `scripturi/verificare/`

Scripturile de verificare și de pregătire rulate pe gazde în etapele de
diagnostic: interogarea schemei, verificarea autentificării la baza de date,
sondele de disponibilitate și corecțiile pregătitoare din etapa P0.

Aceste scripturi sunt **de observare și de pregătire**. Niciunul nu execută
fuziune, publicare sau desfășurare.

## Ce nu intră aici

Valorile de secrete nu apar în niciun fișier din acest director. Unde a fost
nevoie de referire la un secret, se consemnează numai lungimea, amprenta
trunchiată sau drepturile fișierului. Directorul a fost verificat prin căutare
de tipare de acreditări înainte de prima punere sub control de versiune.
