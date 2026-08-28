# Scripturi de producție de pe gazda secundară (Hetzner)

Acest dosar aduce sub control de versiune fișierele care rulează efectiv în producție
pe gazda secundară și care, până acum, existau numai pe disc, într-un depozit local
fără telecomandă. Sunt exact fișierele pe care crontabul le apelează, nici unul mai mult.

## Provenienţă

Extrase din `/opt/ronor/` pe gazda secundară, verificate octet cu octet prin `sha256`
la transfer. Copia lor a fost confirmată identică cu originalul de pe gazdă.

Fișierul `raportare/trimite.py` de pe gazdă s-a dovedit identic cu `ops/raportare/trimite.py`
deja versionat aici, deci nu a fost duplicat. Aceasta confirmă că dosarul `raportare/`
de pe gazdă provine din acest repozitoriu.

## Ce apelează crontabul

| Punct de intrare | Cadenţă | Rol |
| --- | --- | --- |
| `run_report_nou.sh` | zilnic 04:00, zilnic 20:45, vineri 14:00 | generarea rapoartelor de dimineaţă, de seară şi a listei de sarcini |
| `run_audit.sh backup` | zilnic 02:30 | copia de rezervă locală a bazelor, instantaneelor vectoriale şi codului |
| `run_audit.sh restaurare` | duminică 03:30 | proba de restaurare pe date reale, într-un spaţiu de unică folosinţă |
| `run_audit.sh maturitate` | duminică 04:00 | auditul de maturitate al platformei |
| `run_audit.sh surse` | miercuri 04:30 | analiza surselor externe |

## Lanţul de dependenţe

- `run_audit.sh` → `analiza_surse.py`, `backup_hetzner.sh`, `maturitate.py`, `test_restaurare.sh`
- `run_report_nou.sh` → `run_report.sh` → `ronor_report.py`, şi `raportare/trimite.py`

## Observaţii de conţinut

- Niciun fişier nu conţine credenţiale scrise direct. Toate citesc din mediu sau din
  `/opt/ronor/.report_env`, care rămâne exclusiv pe gazdă, cu drepturi `600`, şi nu
  este replicat niciodată în copiile de rezervă.
- `backup_hetzner.sh` este versiunea corectată: nu mai raportează `[parţial]` pentru
  arhiva de cod. `tar` iese cu cod `1` pentru „file changed as we read it", ceea ce este
  normal pe un arbore viu şi nu indică pierdere de date. Verdictul se dă acum pe două
  condiţii simultane — cod de ieşire `≤ 1` şi cel puţin 2000 de fişiere în arhiva
  rezultată — altfel raportează `[EŞEC]` cu codul şi numărul efectiv.

## Ce nu se află aici

Fişierele de unică folosinţă acumulate pe gazdă în timpul depanărilor — corecţii,
diagnostice, umbre `.bak` şi `.pre_*` — au fost arhivate separat pe gazdă, reversibil,
şi nu au fost aduse în repozitoriu. Niciunul nu era apelat de crontab, de systemd,
de containere sau de vreun alt script activ.

---

*NrgPaths Advisory Ltd*
