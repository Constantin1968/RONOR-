#!/usr/bin/env bash
# Instalează modulul de energie pe nodul RONOR și îl leagă de creierul lui (Ollama).
# Rulați din directorul despachetat, pe host-ul cu Docker (Hetzner):
#
#   OLLAMA_URL=http://contabo:11434 OLLAMA_BASE=qwen2.5 ./ronor/install.sh
#
# Variabile opționale:
#   RONOR_NETWORK   rețeaua Docker a celorlalte containere RONOR (se atașează la ea)
#   OLLAMA_BASE     modelul de bază din care se creează 'ronor-energy' (implicit qwen2.5)
#   ET_API_TOKEN    secretul pentru dispatcher; se generează dacă lipsește
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "lipsește: $1"; exit 1; }; }
need docker; need python3; need curl

say "1/5  Configurare (.env)"
[ -f .env ] || cp .env.example .env
setvar() {  # setvar KEY VALUE — scrie/înlocuiește în .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
current() { grep "^$1=" .env | head -1 | cut -d= -f2-; }
[ -n "$(current ET_API_TOKEN)" ] || setvar ET_API_TOKEN "${ET_API_TOKEN:-$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets;print(secrets.token_hex(24))')}"
[ -z "${OLLAMA_URL:-}" ] || setvar OLLAMA_URL "$OLLAMA_URL"
setvar OLLAMA_MODEL "${OLLAMA_MODEL:-ronor-energy}"
setvar OLLAMA_TIMEOUT "${OLLAMA_TIMEOUT:-120}"
setvar ET_SCHEDULER_ENABLED true
OLLAMA_URL="$(current OLLAMA_URL)"; TOKEN="$(current ET_API_TOKEN)"
echo "  OLLAMA_URL=${OLLAMA_URL:-<nesetat: doar răspunsuri deterministe>}  OLLAMA_MODEL=$(current OLLAMA_MODEL)"

say "2/5  Container (docker compose)"
COMPOSE=(docker compose -f docker-compose.yml)
if [ -n "${RONOR_NETWORK:-}" ]; then
  docker network inspect "$RONOR_NETWORK" >/dev/null 2>&1 || docker network create "$RONOR_NETWORK"
  cat > ronor/compose.network.yml <<EOF
services:
  agent:
    networks: [default, ronor]
networks:
  ronor:
    external: true
    name: $RONOR_NETWORK
EOF
  COMPOSE+=(-f ronor/compose.network.yml)
  echo "  atașat la rețeaua $RONOR_NETWORK — dispatcher-ul îl vede ca http://energy-trading-agent:8000"
fi
"${COMPOSE[@]}" up -d --build

say "3/5  Sănătate"
for _ in $(seq 1 30); do
  if curl -fs localhost:8000/api/health >/dev/null 2>&1; then break; fi; sleep 1
done
curl -fs localhost:8000/api/health | python3 -m json.tool

say "4/5  Creierul: modelul 'ronor-energy' (doctrina în SYSTEM) pe Ollama"
if [ -n "$OLLAMA_URL" ] && curl -fs "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  docker compose exec -T agent python -m energy_trading.ronor_agent \
      --ollama "$OLLAMA_URL" --model "$(current OLLAMA_MODEL)" --create-model "${OLLAMA_BASE:-qwen2.5}" \
    || echo "  (nu am putut crea modelul — verificați că '${OLLAMA_BASE:-qwen2.5}' e tras: ollama pull ${OLLAMA_BASE:-qwen2.5})"
  docker compose restart agent >/dev/null
else
  echo "  Ollama indisponibil la '${OLLAMA_URL:-?}' — sar peste. Rulați din nou cu OLLAMA_URL=... când e accesibil."
fi

say "5/5  Fișiere pentru RONOR (regenerate din registru)"
docker compose exec -T agent python -m energy_trading.capabilities > ronor/tools.json
docker compose exec -T agent python -m energy_trading.ronor_agent --modelfile "${OLLAMA_BASE:-qwen2.5}" > ronor/Modelfile
echo "  ronor/tools.json  ronor/Modelfile  ronor/dispatcher_plugin.py"

cat <<EOF

✅ Gata. Ce urmează, în dispatcher-ul RONOR:

  from dispatcher_plugin import EnergyModule
  energy = EnergyModule("http://energy-trading-agent:8000", token="$TOKEN",
                        trading_chats={"<id-ul grupului de trading>"})
  reply = energy.handle(msg, download_file=telegram_download)   # None = nu e al meu

Test rapid (de pe host):
  curl -s -X POST localhost:8000/api/ronor -H 'content-type: application/json' \\
       -H 'X-RONOR-Token: $TOKEN' -d '{"text":"cum stă ziua?","who":"$(whoami)"}'

MCP pentru alți agenți din nod:
  ET_API_URL=http://localhost:8000 ET_API_TOKEN=$TOKEN docker compose exec -T agent python -m energy_trading.mcp_server
EOF
