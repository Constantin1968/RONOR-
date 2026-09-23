# Replicarea Hetzner–Contabo: lotul de corecție propus

Stare: aprobat explicit și instalat la 23 septembrie 2026, 20:25–20:27 UTC.
Rularea unică de validare a trecut: 23 de fișiere identice, permisiuni private,
legătură relativă validă. Descrierea de mai jos consemnează domeniul lotului;
nu autorizează o nouă instalare sau o nouă rulare.

## Destinații și modificări

- Hetzner `178.104.118.10`: păstrarea versiunii curente a
  `/usr/local/sbin/ronor-offsite.sh` într-un director root cu modul 700;
  instalarea `offsite_sync.sh` în locul lui, cu modul 700, și a
  `offsite_verify.py` în `/usr/local/lib/ronor/`, cu modul 600.
  Fișierul înlocuit trebuie să aibă SHA-256
  `637b49698470e6411d9ed80b9dd3361ce51ca97c937fd9785ccc43a4eeddae6c`;
  orice divergență blochează instalarea până la reverificare.
- Contabo `100.87.14.42`: directorul existent `/opt/ronor-backups-offsite`
  devine root:root, 700. Replicarea păstrează drepturile proprietarului, elimină
  drepturile grupului și ale celorlalți și atribuie root:root obiectelor
  transferate. Nu șterge copii și nu mută datele în altă destinație.
- Fluxul existent continuă să copieze `/opt/ronor-backups/`, inclusiv arhivele
  separate de secrete deja prezente pe această destinație. Nu se livrează
  conținutul lor în conversație, GitHub sau documente.
- Se elimină propagarea ștergerilor și se activează verificarea strictă SSH
  folosind `/root/.ssh/known_hosts`. Un eșec de transfer sau verificare devine
  rezultat nenul, nu succes.
- După compararea amprentelor tuturor fișierelor fotografiei curente și a arhivei
  sale separate, `hetzner-local/latest` devine o legătură relativă validă.
  O copie nevalidată nu este promovată.

## Verificarea după instalare

Se verifică amprentele fișierelor instalate, sintaxa Bash/Python fără apelarea
serviciilor, apoi se execută o singură replicare prin procedura nouă.
Acceptarea cere cod zero, comparație identică, `latest` rezolvabil și permisiuni
private pe destinație. Cod zero nu înseamnă restaurare reușită.

Înaintea rulării se recitește spațiul liber. La observația din această sesiune,
destinația avea 488 GiB disponibili conform afișării rotunjite `df -h`; acest
număr nu este rezervare și trebuie reverificat.

## Excluderi și riscuri rămase

Nu se schimbă autentificarea, parolele, cheile, firewallul, botul, modelele,
containerele, politicile de guvernanță, programarea cron sau datele sursă.
Nu se instalează candidatul runtime și nu se modifică referințele de acceptare.
Nu se lansează restaurare, mesaj de test sau inferență de model.

Omiterea ștergerilor crește spațiul ocupat în timp; o retenție independentă și
monitorizarea capacității rămân necesare. Destinația rămâne modificabilă prin
accesul root existent; această etapă nu închide riscul compromiterii sursei.
Legăturile absolute nesigure sunt omise de rsync `--safe-links`; noua verificare
acoperă fotografia datată curentă și arhiva separată, nu întregul istoric.

## Revenire

La eșec se păstrează jurnalul și nu se șterge nicio copie. Scriptul anterior și
starea vechii legături sunt conservate ca probe, dar nu se reactivează automat:
scriptul vechi poate redeschide permisiunile la următoarea replicare. Orice
revenire care reexpune datele necesită decizie explicită. Codul vechi are limite
cunoscute și restaurarea lui nu înseamnă remediere. În rularea aprobată nu a
fost necesară revenirea.
