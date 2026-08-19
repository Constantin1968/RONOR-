#!/usr/bin/env bash
# ============================================================================
# RONOR — Deployment
# ----------------------------------------------------------------------------
# Builds and brings up the production composition on a host already prepared by
# deploy/setup-server.sh, then VERIFIES the result and reports what it actually
# observed.
#
# Usage (from the repository root, as the `ronor` user):
#
#   ./deploy/deploy.sh --first-run           # initial bring-up + provisioning
#   ./deploy/deploy.sh                       # update: pull, rebuild, restart
#   ./deploy/deploy.sh --with-edge           # include the nginx TLS edge
#   ./deploy/deploy.sh --with-telegram       # include the Telegram bridge
#   ./deploy/deploy.sh --rollback            # return to the previous image
#   ./deploy/deploy.sh --check               # verify only, change nothing
#
# Design commitments
# ------------------
#   · PREFLIGHT BEFORE ANY MUTATION. Every required variable, file and port is
#     checked before the first container is touched. A deploy that fails halfway
#     leaves a half-configured runtime, which is worse than one that refuses to
#     start.
#   · THE PREVIOUS IMAGE IS TAGGED BEFORE THE BUILD. Rollback is then a retag and
#     a restart, not a git operation under pressure.
#   · VERIFICATION IS REPORTED, NOT ASSUMED. The script reads
#     /api/runtime/health and prints the runtime's own answer, including
#     `degraded`. It exits non-zero when the runtime is not ready.
#   · IT NEVER PRINTS A SECRET. Values are reported as present/absent and by
#     length, never by content.
#
# Prepared by AMB · Mayleven Ecosystem
# ============================================================================

set -Eeuo pipefail

readonly C_RESET=$'\033[0m'; readonly C_BOLD=$'\033[1m'
readonly C_RED=$'\033[31m';  readonly C_GREEN=$'\033[32m'
readonly C_YELLOW=$'\033[33m'; readonly C_BLUE=$'\033[34m'
log()   { printf '%s→%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
ok()    { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '%s✗%s %s\n' "$C_RED"   "$C_RESET" "$*" >&2; exit 1; }
head1() { printf '\n%s%s%s\n%s\n' "$C_BOLD" "$*" "$C_RESET" \
          "────────────────────────────────────────────────────────────"; }
trap 'fail "aborted at line $LINENO: ${BASH_COMMAND}"' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

readonly COMPOSE_FILE="docker-compose.production.yml"
readonly ENV_FILE=".env.production"
readonly PREV_TAG="ronor:previous"

FIRST_RUN=false
WITH_EDGE=false
WITH_TELEGRAM=false
ROLLBACK=false
CHECK_ONLY=false
NO_BUILD=false
SKIP_GIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --first-run)     FIRST_RUN=true; shift ;;
    --with-edge)     WITH_EDGE=true; shift ;;
    --with-telegram) WITH_TELEGRAM=true; shift ;;
    --rollback)      ROLLBACK=true; shift ;;
    --check)         CHECK_ONLY=true; shift ;;
    --no-build)      NO_BUILD=true; shift ;;
    --skip-git)      SKIP_GIT=true; shift ;;
    -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
    *)               fail "unknown flag: $1 (use --help)" ;;
  esac
done

compose() {
  local args=(-f "$COMPOSE_FILE" --env-file "$ENV_FILE")
  $WITH_EDGE     && args+=(--profile edge)
  $WITH_TELEGRAM && args+=(--profile telegram)
  docker compose "${args[@]}" "$@"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight() {
  head1 "Preflight"

  command -v docker >/dev/null || fail "docker not installed — run deploy/setup-server.sh first"
  docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin missing"
  docker info >/dev/null 2>&1 || fail "cannot talk to the docker daemon (is the user in the 'docker' group? re-login after setup-server.sh)"
  ok "docker $(docker --version | cut -d, -f1 | awk '{print $3}'), compose $(docker compose version --short)"

  [[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE not found — run from the repository root"
  [[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found. Copy .env.production.template to $ENV_FILE, fill it, then chmod 600 it."

  # A world-readable credential file on a shared host is a disclosure. Fixed
  # rather than merely reported.
  local perms; perms="$(stat -c '%a' "$ENV_FILE")"
  if [[ "$perms" != "600" ]]; then
    warn "$ENV_FILE mode is $perms — tightening to 600"
    chmod 600 "$ENV_FILE"
  fi
  ok "$ENV_FILE present, mode 600"

  # Required variables. Checked by NAME and non-emptiness only; the values are
  # never echoed.
  local required=(RONOR_API_KEYS RONOR_ADMIN_API_KEY REDIS_PASSWORD KNOWLEDGE_QDRANT_API_KEY)
  $WITH_TELEGRAM && required+=(TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS TELEGRAM_APPROVER_USER_IDS)
  $WITH_EDGE     && required+=(RONOR_DOMAIN CERTBOT_EMAIL)

  local missing=() placeholder=()
  for v in "${required[@]}"; do
    local val; val="$(grep -E "^${v}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
    if [[ -z "$val" ]]; then
      missing+=("$v")
    elif [[ "$val" == *"<generate>"* || "$val" == *"example.com"* ]]; then
      placeholder+=("$v")
    fi
  done
  if ((${#missing[@]})); then
    printf '\n'; fail "these variables are empty in $ENV_FILE: ${missing[*]}"
  fi
  if ((${#placeholder[@]})); then
    printf '\n'; fail "these variables still hold template placeholders: ${placeholder[*]} — generate real values with: openssl rand -hex 32"
  fi
  ok "${#required[@]} required variables present and non-placeholder"

  # At least one generative provider key, or the runtime boots `degraded` and the
  # healthcheck will (correctly) call it unhealthy. Warned, not blocked — a
  # deterministic-only deployment is a legitimate governed configuration.
  local gen=0
  for v in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY PERPLEXITY_API_KEY; do
    local val; val="$(grep -E "^${v}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
    [[ -n "$val" ]] && gen=$((gen+1))
  done
  if ((gen == 0)); then
    warn "no generative provider key set. /api/runtime/health will report 'degraded' and the container healthcheck will fail — by design, not by accident."
  else
    ok "$gen generative provider key(s) configured"
  fi

  # Compose file validity. Catches a YAML or interpolation error before anything
  # is built.
  compose config -q || fail "compose file failed validation"
  ok "compose configuration valid"

  # Disk. A build needs headroom; a full disk during `docker build` fails in a way
  # that looks like a compiler error.
  local avail; avail="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  if (( avail < 5 )); then
    fail "only ${avail}G free on / — the image build needs ~4G. Run: docker system prune -af"
  fi
  ok "${avail}G free on /"

  # Memory. 2 GB total is the documented floor and only holds with swap present.
  local mem_mb swap_mb
  mem_mb="$(free -m | awk '/^Mem:/{print $2}')"
  swap_mb="$(free -m | awk '/^Swap:/{print $2}')"
  if (( mem_mb < 1800 )); then
    warn "${mem_mb}MB RAM detected — below the 2 GB floor. Expect OOM during build."
  fi
  if (( swap_mb == 0 )); then
    warn "no swap. A 2 GB host will likely OOM-kill the TypeScript build. Add swap: setup-server.sh --swap-gb 2"
  fi
  ok "memory: ${mem_mb}MB RAM, ${swap_mb}MB swap"
}

# ---------------------------------------------------------------------------
# Health verification — reads the runtime's own answer
# ---------------------------------------------------------------------------
verify_health() {
  head1 "Verification"

  local url="http://127.0.0.1:3000/api/runtime/health"
  # 120s hard ceiling. Cold start is ~12s; provider probes add ~10s more.
  # A container that has not answered in 120s has a problem that logs will
  # explain better than continued polling.
  local max_wait=120
  local deadline=$((SECONDS + max_wait))
  local body="" code=""

  log "polling $url (max ${max_wait}s; cold start is ~12s plus provider probes)"
  while (( SECONDS < deadline )); do
    code="$(curl -s -o /tmp/ronor-health.json -w '%{http_code}' --max-time 10 "$url" || echo 000)"
    if [[ "$code" == "200" || "$code" == "503" ]]; then
      body="$(cat /tmp/ronor-health.json)"
      break
    fi
    sleep 5
    printf '.'
  done
  printf '\n'

  if [[ -z "$body" ]]; then
    warn "the runtime did not answer within ${max_wait}s. Last 60 log lines:"
    compose logs --tail 60 ronor || true
    fail "health endpoint unreachable — deployment NOT verified"
  fi

  # Parsed and reported verbatim. Not summarised into a green tick.
  local status providers generative policy records findings
  status="$(jq -r '.status' /tmp/ronor-health.json)"
  providers="$(jq -r '.providers.invocable' /tmp/ronor-health.json)"
  generative="$(jq -r '.providers.generative_invocable' /tmp/ronor-health.json)"
  policy="$(jq -r '.policy_version' /tmp/ronor-health.json)"
  records="$(jq -r '.audit_chain.records' /tmp/ronor-health.json)"
  findings="$(jq -r '.security_findings | length' /tmp/ronor-health.json)"

  printf '  http status        : %s\n' "$code"
  printf '  runtime status     : %s\n' "$status"
  printf '  providers invocable: %s (generative: %s)\n' "$providers" "$generative"
  printf '  MI9 policy version : %s\n' "$policy"
  printf '  audit chain records: %s\n' "$records"
  printf '  knowledge plane    : %s (degradation %s)\n' \
    "$(jq -r '.knowledge.enabled' /tmp/ronor-health.json)" \
    "$(jq -r '.knowledge.degradation_level' /tmp/ronor-health.json)"

  if [[ "$findings" != "0" ]]; then
    warn "SECURITY FINDINGS reported by the runtime:"
    jq -r '.security_findings[] | "      - " + .' /tmp/ronor-health.json >&2
  fi

  # Audit chain integrity, using the admin key. A runtime that answers requests
  # but whose chain does not verify is not a runtime anyone should trust.
  local admin_key; admin_key="$(grep -E '^RONOR_ADMIN_API_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  if [[ -n "$admin_key" ]]; then
    local vcode; vcode="$(curl -s -o /tmp/ronor-verify.json -w '%{http_code}' --max-time 15 \
      -H "Authorization: Bearer ${admin_key}" \
      http://127.0.0.1:3000/api/runtime/audit/verify || echo 000)"
    if [[ "$vcode" == "200" ]]; then
      ok "audit chain verifies (HTTP 200)"
    elif [[ "$vcode" == "409" ]]; then
      warn "AUDIT CHAIN DOES NOT VERIFY (HTTP 409). Investigate before trusting any output."
      jq -r '.verification' /tmp/ronor-verify.json >&2 || true
    else
      warn "audit verification returned HTTP $vcode — inconclusive, not green"
    fi
  fi

  compose ps --format 'table {{.Name}}\t{{.Status}}' | sed 's/^/    /'

  if [[ "$status" == "ready" ]]; then
    ok "runtime READY"
    return 0
  fi
  warn "runtime is '$status', not 'ready'. It is live and governed, but no generative provider is reachable. This is reported, not hidden."
  return 1
}

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
if $ROLLBACK; then
  head1 "Rollback"
  docker image inspect "$PREV_TAG" >/dev/null 2>&1 \
    || fail "no $PREV_TAG image exists — nothing to roll back to"
  rollback_version="$(grep -E '^RONOR_VERSION=' "$ENV_FILE" | cut -d= -f2- || echo 0.5.0)"
  docker tag "$PREV_TAG" "ronor:${rollback_version}"
  compose up -d --no-build
  verify_health || exit 1
  ok "rolled back to the previous image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Check only
# ---------------------------------------------------------------------------
if $CHECK_ONLY; then
  preflight
  verify_health || exit 1
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
head1 "RONOR — deploy"
printf '  repo    : %s\n' "$REPO_ROOT"
printf '  branch  : %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a git checkout')"
printf '  commit  : %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
printf '  profiles: %s%s\n' "$($WITH_EDGE && echo 'edge ')" "$($WITH_TELEGRAM && echo 'telegram')"

preflight

# Pull the branch, unless told not to. Deliberately does NOT switch branches: a
# deploy script that changes what is checked out can deploy something other than
# what the operator inspected.
if ! $SKIP_GIT && [[ -d .git ]]; then
  head1 "Source"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "working tree has uncommitted changes — deploying them as they stand, without pulling"
  else
    log "git pull --ff-only origin $branch"
    git pull --ff-only origin "$branch" || warn "pull failed (offline, or the branch has diverged) — deploying the current checkout"
  fi
  ok "at $(git rev-parse --short HEAD) on $branch"
fi

# Tag the current image BEFORE the build, so --rollback has a target.
head1 "Build"
version="$(grep -E '^RONOR_VERSION=' "$ENV_FILE" | cut -d= -f2- || echo 0.5.0)"
if docker image inspect "ronor:${version}" >/dev/null 2>&1; then
  docker tag "ronor:${version}" "$PREV_TAG"
  ok "previous image tagged $PREV_TAG (rollback target)"
else
  warn "no existing ronor:${version} image — this is a first build, and --rollback will have no target until the next deploy"
fi

if $NO_BUILD; then
  warn "skipping build by flag"
else
  log "docker compose build (this compiles TypeScript in strict mode; a type error fails the deploy here, which is where it should fail)"
  compose build --pull ronor || fail "image build failed — nothing was restarted, the previous deployment is untouched"
  ok "image built: ronor:${version}"
fi

head1 "Bring-up"
compose up -d --remove-orphans
ok "containers started"

# ---------------------------------------------------------------------------
# First-run provisioning
# ---------------------------------------------------------------------------
if $FIRST_RUN; then
  head1 "First-run provisioning"

  log "waiting for Qdrant to accept connections"
  for _ in $(seq 1 30); do
    if compose exec -T qdrant bash -c ':> /dev/tcp/127.0.0.1/6333' 2>/dev/null; then break; fi
    sleep 2
  done

  log "provisioning Qdrant collections (ronor_memory, ronor_knowledge, ronor_missions)"
  if compose exec -T ronor node dist/scripts/provision-qdrant.js; then
    ok "Qdrant collections provisioned"
  else
    warn "Qdrant provisioning FAILED. The runtime still starts; retrieval will degrade and say so. Re-run: docker compose exec ronor node dist/scripts/provision-qdrant.js"
  fi

  log "applying Supabase schema (idempotent)"
  if compose exec -T ronor node dist/scripts/provision-supabase.js; then
    ok "Supabase schema applied"
  else
    warn "Supabase provisioning failed or was skipped (SUPABASE_SERVICE_ROLE_KEY absent). Durable persistence is NOT active; the runtime falls back to local SQLite and reports it."
  fi

  if $WITH_EDGE; then
    log "issuing the TLS certificate"
    domain="$(grep -E '^RONOR_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
    email="$(grep -E '^CERTBOT_EMAIL=' "$ENV_FILE" | cut -d= -f2-)"
    # --staging first would be safer against rate limits; the operator can add it.
    if compose run --rm --entrypoint certbot certbot certonly \
        --webroot -w /var/www/certbot \
        -d "$domain" --email "$email" --agree-tos --no-eff-email --non-interactive; then
      ok "certificate issued for $domain"
      compose exec nginx nginx -s reload || compose restart nginx
    else
      warn "certificate issuance FAILED. Common causes: the A record for $domain does not point at this host yet, or port 80 is closed. nginx will not serve HTTPS until this succeeds."
    fi
  fi
fi

verify_health || {
  warn "deployment completed but the runtime is NOT ready. Nothing has been rolled back — inspect and decide:"
  printf '    docker compose -f %s logs -f ronor\n' "$COMPOSE_FILE"
  printf '    ./deploy/deploy.sh --rollback\n'
  exit 1
}

head1 "Deployed"
cat <<SUMMARY
  runtime   : http://127.0.0.1:3000  (loopback only)
  console   : http://127.0.0.1:3000/console
  health    : http://127.0.0.1:3000/api/runtime/health
$($WITH_EDGE && printf '  public    : https://%s\n' "$(grep -E '^RONOR_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)")
$(command -v tailscale >/dev/null 2>&1 && printf '  tailnet   : http://%s:3000\n' "$(tailscale ip -4 2>/dev/null | head -1)")

  logs      : docker compose -f $COMPOSE_FILE logs -f ronor
  status    : ./deploy/deploy.sh --check
  rollback  : ./deploy/deploy.sh --rollback

Prepared by AMB · Mayleven Ecosystem
SUMMARY
