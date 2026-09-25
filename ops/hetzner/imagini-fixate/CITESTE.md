# Imagini fixate pe digest, gazda secundară

Treisprezece proiecte compose de pe gazda secundară (Hetzner) folosesc etichete mobile, de exemplu `latest`, `main`, `3-latest`, `4`, `7`, `17`, `alpine`. Asta înseamnă că o reconstrucție de pe o gazdă curată ar trage altă imagine decât cea care rulează. Acest director fixează fiecare serviciu care folosește o imagine dintr-un registru public pe digest-ul care rula la 25 septembrie 2026.

Fixarea a fost probată pe o gazdă curată. Toate cele 30 de imagini s-au putut trage pe digest, iar proiectele au pornit și au trecut verificările de sănătate, inclusiv după repornirea gazdei.

## Conținut

- `manifest.tsv` — proiectul, serviciul, directorul compose, eticheta anterioară și imaginea fixată.
- `compose.digest.<proiect>.yaml` — câte o suprapunere pentru fiecare proiect. Fișierele compose existente nu se modifică.
- `verifica-imagini.sh` — verifică, numai prin citire, că fiecare serviciu rulează imaginea din manifest. Codurile de ieșire sunt: 0 = totul corespunde, 1 = abatere, 2 = serviciu care nu rulează.

## Folosire

```
cd /opt/<proiect>
docker compose -f docker-compose.yml -f /cale/ops/hetzner/imagini-fixate/compose.digest.<proiect>.yaml up -d
```

## Limite

- Imaginile construite local nu apar aici, fiindcă nu există în niciun registru: `ronor/*`, `app-ronor`, `cidavault`, `ronor-development-*`, `ronor-bot-*`. Ele se reconstruiesc din sursă, iar comparația fișier cu fișier a confirmat identitatea lor.
- Postgres-ul Langfuse nu are în producție un digest de registru, doar identificatorul local `a426e44b…`. Imaginea s-a tras după acest identificator, deci el e folosit ca fixare.
- Serviciul `autogen` rulează la fiecare pornire `pip install autogenstudio` fără versiune fixată. Fixarea imaginii de bază nu fixează și pachetul instalat.
- Actualizarea unei imagini devine o decizie explicită: se schimbă digest-ul în manifest și în suprapunere, printr-o cerere de integrare.
- În producție, containerul `ronor-qdrant` aparține proiectului `ronor-expansion`, iar rețeta de reconstrucție CIDA îl crea separat, fără etichetă de proiect. Pe gazda curată, qdrant a fost trecut sub `ronor-expansion`, cu datele copiate în volumul acestuia, și abia apoi fixarea a trecut 30 din 30.
