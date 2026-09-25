# Imagini fixate pe digest, gazda secundară

Treisprezece proiecte compose de pe gazda secundară (Hetzner) folosesc etichete mobile, de exemplu `latest`, `main`, `3-latest`, `4`, `7`, `17`, `alpine`. Asta înseamnă că o reconstrucție de pe o gazdă curată ar trage altă imagine decât cea care rulează. Acest director fixează fiecare serviciu care folosește o imagine dintr-un registru public pe digest-ul care rula la 25 septembrie 2026.

Fixarea a fost probată pe o gazdă curată. 29 dintre cele 30 de imagini s-au tras pe digest, iar una, `minio/minio` pentru `cida-minio`, a fost încărcată dintr-o arhivă `docker save` (vezi „Imagine retrasă din registru”). Proiectele au pornit și au trecut verificările de sănătate, inclusiv după repornirea gazdei.

## Conținut

- `manifest.tsv` — proiectul, serviciul, directorul compose, eticheta anterioară și imaginea fixată.
- `compose.digest.<proiect>.yaml` — câte o suprapunere pentru fiecare proiect. Fișierele compose existente nu se modifică.
- `verifica-imagini.sh` — verifică, numai prin citire, că fiecare serviciu rulează imaginea din manifest. Codurile de ieșire sunt: 0 = totul corespunde, 1 = abatere, 2 = serviciu care nu rulează.

## Folosire

```
cd /opt/<proiect>
docker compose -f docker-compose.yml -f /cale/ops/hetzner/imagini-fixate/compose.digest.<proiect>.yaml up -d
```

## Imagine retrasă din registru: `cida-minio`

MinIO a șters depozitele `minio/minio` și `minio/mc` de pe Docker Hub la 11 septembrie 2026. De atunci, `minio/minio@sha256:a1ea29fa…`, fixarea serviciului `cida-minio`, nu se mai poate trage din registru („pull access denied … repository does not exist”). Celelalte 26 dintre cele 27 de digest-uri unice din manifest se mai rezolvă (HTTP 200) pe Docker Hub, `ghcr.io` și `cgr.dev`, la verificarea anonimă din 25 septembrie 2026.

Sursa reală a imaginii este arhiva `docker save` făcută pe gazda secundară, `minio-RELEASE.2025-04-22T22-12-26Z.tar.gz`, păstrată cu `SHA256SUMS` în depozitul de fișiere al proiectului, la `ronor/infrastructura/retete/ronor-secondary/imagini-retrase/`. Identificatorul imaginii după încărcare este același ca în producție, `sha256:a1ea29fa…`.

Reconstrucția acestui serviciu:

```
sha256sum -c SHA256SUMS
gunzip -c minio-RELEASE.2025-04-22T22-12-26Z.tar.gz | docker load
cd /opt/cida
docker compose -f docker-compose.yml -f /cale/ops/hetzner/imagini-fixate/compose.digest.cida.yaml up -d --pull never
```

Fără arhivă, reconstrucția după manifest eșuează la `cida-minio`. O alternativă durabilă este publicarea imaginii într-un registru privat și schimbarea fixării în manifest și în suprapunere.

Fixarea pe digest nu garantează că imaginea rămâne disponibilă la sursă. Merită verificat periodic că digest-urile din manifest se rezolvă încă în registru.

## Limite

- Imaginile construite local nu apar aici, fiindcă nu există în niciun registru: `ronor/*`, `app-ronor`, `cidavault`, `ronor-development-*`, `ronor-bot-*`. Ele se reconstruiesc din sursă, iar comparația fișier cu fișier a confirmat identitatea lor.
- Postgres-ul Langfuse este fixat pe `postgres@sha256:a426e44b…`. Acesta este un digest de registru valid: `docker.io/postgres@sha256:a426e44b…` se rezolvă pe Docker Hub (HTTP 200, verificat la 25 septembrie 2026).
- Serviciul `autogen` rulează la fiecare pornire `pip install autogenstudio` fără versiune fixată. Fixarea imaginii de bază nu fixează și pachetul instalat.
- Actualizarea unei imagini devine o decizie explicită: se schimbă digest-ul în manifest și în suprapunere, printr-o cerere de integrare.
- În producție, containerul `ronor-qdrant` aparține proiectului `ronor-expansion`, iar rețeta de reconstrucție CIDA îl crea separat, fără etichetă de proiect. Pe gazda curată, qdrant a fost trecut sub `ronor-expansion`, cu datele copiate în volumul acestuia, și abia apoi fixarea a trecut 30 din 30 (29 trase din registru, una încărcată din arhivă).
