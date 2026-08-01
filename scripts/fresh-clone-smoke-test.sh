#!/usr/bin/env bash
#
# Fresh-clone smoke test — the exact procedure a Build Week judge will use.
# Runs everything from a clean git clone and verifies the pipeline works.
#
# Usage:
#   bash scripts/fresh-clone-smoke-test.sh
#
# Or, from anywhere, to simulate a truly fresh clone:
#   cd /tmp && rm -rf ronor-judge-test && \
#   git clone -b build-week https://github.com/Constantin1968/RONOR-.git ronor-judge-test && \
#   cd ronor-judge-test && bash scripts/fresh-clone-smoke-test.sh
#
set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
pass() { echo "${GREEN}✓${NC} $1"; }
fail() { echo "${RED}✗${NC} $1"; exit 1; }
step() { echo "${BOLD}${YELLOW}▶${NC} ${BOLD}$1${NC}"; }

echo
echo "${BOLD}RONOR — fresh-clone smoke test${NC}"
echo "================================"
echo

step "Node version check"
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node 20+ required (found $(node -v))"
fi
pass "Node $(node -v)"

step "Install dependencies"
npm ci --silent 2>&1 | tail -3
pass "npm ci"

step "TypeScript compile"
npx tsc --noEmit
pass "tsc --noEmit"

step "Build"
npm run build 2>&1 | tail -3
[ -f dist/index.js ] || fail "dist/index.js missing after build"
[ -f dist/governance/policies.yaml ] || fail "policies.yaml not copied into dist/"
pass "build produced dist/index.js + policies.yaml"

step "Full test suite"
npm test 2>&1 | tail -5
pass "all tests pass"

step "Start server (background, 5s startup wait)"
rm -f /tmp/ronor-smoke.log
OPENAI_API_KEY="${OPENAI_API_KEY:-sk-test-dummy-key}" \
  node dist/index.js > /tmp/ronor-smoke.log 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT
sleep 5
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "--- server log ---"; cat /tmp/ronor-smoke.log; fail "server died"
fi
pass "server up (pid $SERVER_PID)"

step "Endpoint: GET /api/v1/health"
curl -sS -f http://localhost:3000/api/v1/health > /dev/null
pass "/health responds"

step "Endpoint: GET /api/v1/model-exchange/registry"
REG_COUNT=$(curl -sS http://localhost:3000/api/v1/model-exchange/registry | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('models', d if isinstance(d,list) else [])))")
[ "$REG_COUNT" = "5" ] || fail "expected 5 models, got $REG_COUNT"
pass "registry has 5 models"

step "Endpoint: POST /api/v1/model-exchange/route (dry-run)"
ROUTE_OK=$(curl -sS -X POST http://localhost:3000/api/v1/model-exchange/route \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is 2+2?","task_type":"calculation","confidentiality_level":"internal"}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('winner') or d.get('selected') or d.get('routing') else 'no')")
[ "$ROUTE_OK" = "yes" ] || fail "route dry-run returned no winner"
pass "route dry-run picks a winner"

step "Endpoint: POST /api/v1/model-exchange/query (full pipeline)"
QUERY_OUT=$(curl -sS -X POST http://localhost:3000/api/v1/model-exchange/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"810+1.166","task_type":"calculation","confidentiality_level":"internal","operator_id":"judge"}')
HAS_ANSWER=$(echo "$QUERY_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('answer') or d.get('result') else 'no')")
[ "$HAS_ANSWER" = "yes" ] || { echo "$QUERY_OUT" | head -c 500; fail "query returned no answer"; }
pass "query returns an answer"

step "Audit chain verification"
npx tsx scripts/verify-chain.ts 2>&1 | tail -3
pass "audit chain verifies clean"

step "Endpoint: GET /api/v1/model-exchange/ledger/cost"
curl -sS -f http://localhost:3000/api/v1/model-exchange/ledger/cost > /dev/null
pass "cost ledger responds"

step "UI serves"
curl -sS -f http://localhost:3000/ | grep -q "Model Exchange" || fail "UI does not contain Model Exchange tab"
pass "UI HTML contains Model Exchange tab"

echo
echo "${GREEN}${BOLD}=========================================${NC}"
echo "${GREEN}${BOLD}  ALL CHECKS PASSED — READY TO SUBMIT${NC}"
echo "${GREEN}${BOLD}=========================================${NC}"
echo
