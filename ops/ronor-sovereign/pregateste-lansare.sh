#!/bin/bash
# RONOR - pregătirea directorului de lansare al runtime-ului pe gazda primară (ronor-sovereign).
#
# Înlocuiește pasul manual 1 din reconstrucția pe probă (25.09.2026): până acum lansarea
# se făcea copiind de mână suprapunerea din lansarea anterioară, apoi `Dockerfile` ca
# `Dockerfile.runtime` și `REVISION`. Nimic din acestea nu era în git.
#
# Utilizare (din clona depozitului, pe gazdă sau în mediul operatorului):
#   ops/ronor-sovereign/pregateste-lansare.sh <revizie> <director-destinatie>
# Exemplu:
#   ops/ronor-sovereign/pregateste-lansare.sh 1143201 /opt/ronor/releases/main-1143201-$(date -u +%Y%m%dT%H%M%SZ)
#
# Ce NU face: nu scrie `.env.production` (vezi docs/reconstructie-primara-digitalocean.md,
# dependența 4), nu construiește imaginea, nu pornește nimic și nu se conectează la nicio gazdă.
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "utilizare: $0 <revizie> <director-destinatie>" >&2
  exit 2
fi
REV_IN="$1"
DEST="$2"
AICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RADACINA="$(git -C "$AICI" rev-parse --show-toplevel)"

REV="$(git -C "$RADACINA" rev-parse --verify "${REV_IN}^{commit}")"
if [ -e "$DEST" ]; then
  echo "REFUZ: $DEST există deja; o lansare nu se suprascrie" >&2
  exit 3
fi

mkdir -p "$DEST"
git -C "$RADACINA" archive --format=tar "$REV" | tar -xf - -C "$DEST"

# Suprapunerea declarată în depozit (identică, octet cu octet, cu cea din producție la 1143201).
install -m 644 "$AICI/lansare/docker-compose.runtime-override.yml" "$DEST/docker-compose.runtime-override.yml"

# Suprapunerea construiește din `Dockerfile.runtime`. În producție era o copie a lui `Dockerfile`,
# făcută de mână. Aici e copia fișierului din revizia lansată, deci preia `npm ci` din lockfile.
install -m 644 "$DEST/Dockerfile" "$DEST/Dockerfile.runtime"

printf '%s\n' "$REV" > "$DEST/REVISION"
chmod 644 "$DEST/REVISION"

echo "lansare pregătită: $DEST"
echo "REVISION=$REV"
echo "RONOR_VERSION trebuie să fie: ${REV:0:7}"
( cd "$DEST" && sha256sum docker-compose.production.yml docker-compose.runtime-override.yml Dockerfile Dockerfile.runtime package-lock.json REVISION )
echo "urmează: .env.production (dependența 4), PKI (dependența 3), ordinea pornirii (dependența 5)"
