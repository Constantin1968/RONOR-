#!/usr/bin/env bash
# Împachetează tot ce are nevoie nodul RONOR într-un tar.gz (fără stare, fără secrete).
#   ./ronor/pack.sh  →  dist/ronor-energy-<versiune>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(python3 -c "import tomllib;print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")
mkdir -p dist
OUT="dist/ronor-energy-$VER.tar.gz"
tar czf "$OUT" --transform 's,^,ronor-energy/,' \
  --exclude='state' --exclude='.env' --exclude='__pycache__' --exclude='.pytest_cache' \
  --exclude='.ruff_cache' --exclude='dist' --exclude='*.pyc' \
  pyproject.toml README.md requirements.txt Dockerfile docker-compose.yml .dockerignore .env.example \
  start.sh src static templates data docs deploy ronor
echo "$OUT ($(du -h "$OUT" | cut -f1))"
echo "Pe nod:  tar xzf $(basename "$OUT") && cd ronor-energy && OLLAMA_URL=http://<ollama>:11434 ./ronor/install.sh"
