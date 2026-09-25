#!/bin/bash
# RONOR - emiterea autorității interne (CA) și a certificatului TLS al lui Qdrant, gazda primară.
#
# Declară dependența 3 din reconstrucția pe probă (25.09.2026): `/etc/ronor/pki` nu era în
# rețete, în copii sau în vreun script. Fără el Qdrant nu pornește cu TLS, iar runtime-ul nu
# are încredere în certificat (docker-compose.production.yml, după PR #48).
#
# Reguli (lotul D, 25.09.2026):
#   - în /etc/ronor/pki rămân NUMAI ca.crt, qdrant.crt și qdrant.key; directorul e montat în
#     containere, deci cheia privată a CA nu are voie să stea acolo;
#   - ca.key stă într-un director separat, numai pentru root, și intră în arhiva de secrete.
#
# Utilizare:
#   emite-pki-intern.sh ca-nou   <dir-ca>   # CA nouă (10 ani) + certificat Qdrant (2 ani)
#   emite-pki-intern.sh qdrant   <dir-ca>   # numai certificat Qdrant nou, semnat de CA existentă
# Variabile:
#   PKI_DIR   implicit /etc/ronor/pki
#   QDRANT_SAN implicit DNS:qdrant,DNS:ronor-qdrant,DNS:localhost,IP:127.0.0.1
#
# Nu se conectează la nicio gazdă și nu repornește nimic. După emitere: recrearea lui
# ronor-qdrant și ronor-runtime (vezi docs/reconstructie-primara-digitalocean.md).
set -Eeuo pipefail
umask 077

MOD="${1:-}"
CA_DIR="${2:-}"
PKI_DIR="${PKI_DIR:-/etc/ronor/pki}"
QDRANT_SAN="${QDRANT_SAN:-DNS:qdrant,DNS:ronor-qdrant,DNS:localhost,IP:127.0.0.1}"

if [ -z "$MOD" ] || [ -z "$CA_DIR" ]; then
  echo "utilizare: $0 ca-nou|qdrant <dir-ca>" >&2
  exit 2
fi
case "$(readlink -m "$CA_DIR")" in
  "$(readlink -m "$PKI_DIR")"|"$(readlink -m "$PKI_DIR")"/*)
    echo "REFUZ: cheia CA nu se ține în $PKI_DIR (directorul e montat în containere)" >&2
    exit 3 ;;
esac

LUCRU="$(mktemp -d)"
trap 'rm -rf "$LUCRU"' EXIT

mkdir -p "$CA_DIR" "$PKI_DIR"
chmod 700 "$CA_DIR"
chmod 755 "$PKI_DIR"

case "$MOD" in
  ca-nou)
    if [ -e "$CA_DIR/ca.key" ]; then
      echo "REFUZ: $CA_DIR/ca.key există; pentru reemiterea certificatului folosiți modul qdrant" >&2
      exit 4
    fi
    openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
      -subj "/CN=RONOR Internal CA/O=RONOR" -keyout "$LUCRU/ca.key" -out "$LUCRU/ca.crt" 2>/dev/null
    install -m 600 "$LUCRU/ca.key" "$CA_DIR/ca.key"
    install -m 644 "$LUCRU/ca.crt" "$CA_DIR/ca.crt"
    ;;
  qdrant)
    [ -r "$CA_DIR/ca.key" ] && [ -r "$CA_DIR/ca.crt" ] || { echo "REFUZ: lipsește CA în $CA_DIR" >&2; exit 5; }
    ;;
  *)
    echo "mod necunoscut: $MOD" >&2
    exit 2 ;;
esac

openssl req -newkey rsa:2048 -nodes -subj "/CN=qdrant/O=RONOR" \
  -keyout "$LUCRU/qdrant.key" -out "$LUCRU/qdrant.csr" 2>/dev/null
printf 'subjectAltName=%s\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
  "$QDRANT_SAN" > "$LUCRU/qdrant.ext"
openssl x509 -req -in "$LUCRU/qdrant.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
  -CAcreateserial -CAserial "$LUCRU/ca.srl" -days 730 -extfile "$LUCRU/qdrant.ext" \
  -out "$LUCRU/qdrant.crt" 2>/dev/null
openssl verify -CAfile "$CA_DIR/ca.crt" "$LUCRU/qdrant.crt" >/dev/null

install -m 644 "$CA_DIR/ca.crt" "$PKI_DIR/ca.crt"
install -m 644 "$LUCRU/qdrant.crt" "$PKI_DIR/qdrant.crt"
# 640, ca în producție: Qdrant citește cheia prin montarea de fișier din docker-compose.production.yml.
install -m 640 "$LUCRU/qdrant.key" "$PKI_DIR/qdrant.key"
rm -f "$PKI_DIR/ca.key"

echo "PKI emis în $PKI_DIR (fără ca.key); CA în $CA_DIR"
openssl x509 -in "$PKI_DIR/qdrant.crt" -noout -subject -enddate -ext subjectAltName
( cd "$PKI_DIR" && ls -l ca.crt qdrant.crt qdrant.key )
echo "de făcut: $CA_DIR/ca.key în arhiva de secrete; recrearea ronor-qdrant și ronor-runtime"
