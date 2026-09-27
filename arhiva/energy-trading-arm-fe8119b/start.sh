#!/usr/bin/env bash
# One command to run everything. Works with Docker or plain Python.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { cp .env.example .env; echo "Am creat .env — completați TELEGRAM_BOT_TOKEN și TELEGRAM_CHAT_ID când vreți alerte."; }

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
  echo "Pornit în Docker. Dashboard: http://localhost:8000  ·  Stare: curl localhost:8000/api/health"
else
  python3 -m pip install -q -e . 2>/dev/null || python3 -m pip install -q -r requirements.txt
  set -a; . ./.env; set +a
  export ET_SCHEDULER_ENABLED="${ET_SCHEDULER_ENABLED:-true}"
  echo "Pornit local. Dashboard: http://localhost:8000  (Ctrl+C oprește)"
  exec python3 -m uvicorn energy_trading.api:app --host 0.0.0.0 --port 8000
fi
