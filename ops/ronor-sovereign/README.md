# ops/ronor-sovereign

Fișiere pentru reconstrucția gazdei primare (DigitalOcean): runtime-ul RONOR, Qdrant, Redis și
Postgres. Documentul care le leagă este `docs/reconstructie-primara-digitalocean.md`.

| Fișier | Dependența declarată |
|---|---|
| `lansare/docker-compose.runtime-override.yml` | 1: suprapunerea lansării, identică cu producția la `1143201` |
| `pregateste-lansare.sh` | 1: directorul de lansare, cu `Dockerfile.runtime` și `REVISION` |
| `emite-pki-intern.sh` | 3: autoritatea internă și certificatul Qdrant, fără `ca.key` în `/etc/ronor/pki` |
| `docker-compose.postgres-legare.yml` | 5 și 6: Postgres pe `127.0.0.1` și pe adresa Tailscale, ca variabilă |
| `docker-compose.postgres-local.yml` | 6: Postgres numai pe `127.0.0.1`, pe o gazdă fără Tailscale |

Niciun script nu se conectează la o gazdă. Nimic de aici nu conține acreditări.
