#!/usr/bin/env bash
# RONOR — deploy to Railway
#
# Prereqs:
#   1. Install Railway CLI:  npm i -g @railway/cli
#   2. Login:                railway login
#   3. Link project:         railway link   (choose the RONOR project)
#   4. Set the OpenAI key:   railway variables --set "OPENAI_API_KEY=sk-..."
#
# Then:
#   ./scripts/deploy.sh
#
# The script builds the Docker image locally to catch errors fast, then hands
# off to Railway for the production build + deploy.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "─────────────────────────────────────────────"
echo "RONOR — Build Week Deploy"
echo "─────────────────────────────────────────────"

if ! command -v railway >/dev/null 2>&1; then
  echo "✗ Railway CLI not installed. Run: npm i -g @railway/cli"
  exit 1
fi

echo "→ Sanity: local Docker build (catches native-module + tsc errors early)"
if command -v docker >/dev/null 2>&1; then
  docker build -t ronor:build-week . || {
    echo "✗ Local Docker build failed. Fix errors before pushing to Railway."
    exit 1
  }
  echo "✓ Local build ok."
else
  echo "⚠ Docker not available locally — skipping pre-flight build."
fi

echo "→ Checking required Railway env vars"
if ! railway variables --json 2>/dev/null | grep -q '"OPENAI_API_KEY"'; then
  echo "⚠ OPENAI_API_KEY not set on Railway. The demo will run in deterministic fallback mode."
  echo "  To set:  railway variables --set \"OPENAI_API_KEY=sk-...\""
fi

echo "→ Deploying to Railway"
railway up --detach

echo "─────────────────────────────────────────────"
echo "✓ Deploy triggered. Follow logs:"
echo "    railway logs"
echo "─────────────────────────────────────────────"
