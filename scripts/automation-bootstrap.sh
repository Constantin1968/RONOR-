#!/usr/bin/env bash
# RONOR automation activation bootstrap — host-side, idempotent, non-destructive.
#
# Creates ONLY what scripts/automation-preflight.sh audits: the three Docker
# networks, the secret directory with bounded permissions, the Ed25519 receipt
# key pair, the artifact/nonce directories and the dedicated automation clone.
#
# It never overwrites an existing secret, never prints secret material, never
# starts a container and never touches the production stack.
#
# Usage:
#   export RONOR_AUTOMATION_SECRET_DIR=/etc/ronor/automation-secrets
#   export RONOR_AUTOMATION_WORKTREE=/srv/ronor/automation-worktrees/project
#   export RONOR_AUTOMATION_ARTIFACT_ROOT=/srv/ronor/automation-artifacts
#   export RONOR_AUTOMATION_NONCE_DIR=/srv/ronor/automation-nonces
#   export RONOR_AUTOMATION_EXPECTED_ORIGIN=git@github.com:Constantin1968/RONOR-.git
#   export RONOR_AUTOMATION_BRANCH=automation/mission-001
#   export RONOR_AUTOMATION_BASE_COMMIT=<approved-main-sha>
#     NOTE: this variable belongs to THIS script only. automation-preflight.sh
#     reads a different name, RONOR_AUTOMATION_EXPECTED_HEAD, and both must
#     hold the same SHA. Read the approved SHA from the remote rather than
#     hardcoding it:  git ls-remote origin refs/heads/main
#   sudo -E bash scripts/automation-bootstrap.sh

set -Eeuo pipefail
umask 077

SERVICE_UID=10001
SERVICE_GID=10001

info() { printf 'BOOTSTRAP  %s\n' "$1"; }
skip() { printf 'EXISTS     %s\n' "$1"; }
die()  { printf 'ERROR      %s\n' "$1" >&2; exit 1; }

for command in docker git openssl realpath stat; do
  command -v "$command" >/dev/null 2>&1 || die "required command missing: $command"
done

: "${RONOR_AUTOMATION_SECRET_DIR:?set RONOR_AUTOMATION_SECRET_DIR}"
: "${RONOR_AUTOMATION_WORKTREE:?set RONOR_AUTOMATION_WORKTREE}"
: "${RONOR_AUTOMATION_ARTIFACT_ROOT:?set RONOR_AUTOMATION_ARTIFACT_ROOT}"
: "${RONOR_AUTOMATION_NONCE_DIR:?set RONOR_AUTOMATION_NONCE_DIR}"
: "${RONOR_AUTOMATION_EXPECTED_ORIGIN:?set RONOR_AUTOMATION_EXPECTED_ORIGIN}"
: "${RONOR_AUTOMATION_BRANCH:?set RONOR_AUTOMATION_BRANCH (must start with automation/)}"
: "${RONOR_AUTOMATION_BASE_COMMIT:?set RONOR_AUTOMATION_BASE_COMMIT}"

case "$RONOR_AUTOMATION_BRANCH" in
  automation/*) : ;;
  *) die 'RONOR_AUTOMATION_BRANCH must live in the automation/ namespace' ;;
esac

# ---------------------------------------------------------------- networks ---
# automation-control and model-egress carry no route off the host.
# model-uplink is the ONLY externally routable network and is joined solely by
# the model egress reverse proxy.
ensure_network() {
  local name="$1" internal="$2" actual
  actual="$(docker network inspect --format '{{.Internal}}' "$name" 2>/dev/null || true)"
  if [[ -z "$actual" ]]; then
    if [[ "$internal" == true ]]; then
      docker network create --internal "$name" >/dev/null
    else
      docker network create "$name" >/dev/null
    fi
    info "network $name created (internal=$internal)"
  elif [[ "$actual" == "$internal" ]]; then
    skip "network $name already correct (internal=$internal)"
  else
    die "network $name exists with internal=$actual, expected $internal — remove it deliberately, do not adopt it"
  fi
}

ensure_network ronor-automation-control true
ensure_network ronor-model-egress true
ensure_network ronor-model-uplink false

# ------------------------------------------------------------- directories ---
ensure_dir() {
  local path="$1" mode="$2"
  if [[ -d "$path" ]]; then
    skip "directory $path"
  else
    mkdir -p -- "$path"
    info "directory $path created"
  fi
  chown "$SERVICE_UID:$SERVICE_GID" -- "$path"
  chmod "$mode" -- "$path"
}

ensure_dir "$RONOR_AUTOMATION_SECRET_DIR" 0750
ensure_dir "$RONOR_AUTOMATION_ARTIFACT_ROOT" 0700
ensure_dir "$RONOR_AUTOMATION_NONCE_DIR" 0700

# ----------------------------------------------------------------- secrets ---
# Eleven bearer tokens must be pairwise distinct; 48 random bytes each makes a
# collision impossible in practice. The upstream gateway key is NOT generated:
# it is real provider material the operator must place by hand.
TOKENS=(
  langgraph_token
  openhands_session_key
  openhands_llm_api_key
  openhands_secret_key
  openhands_bridge_token
  automation_capability_key
  codex_verifier_token
  codex_api_key
  assurance_token
  evidence_runner_token
)

write_secret() {
  local name="$1" path="$RONOR_AUTOMATION_SECRET_DIR/$1"
  if [[ -e "$path" ]]; then
    skip "secret $name (left untouched)"
    return
  fi
  ( set -o noclobber; openssl rand -base64 48 | tr -d '\n' > "$path" )
  info "secret $name generated"
}

for name in "${TOKENS[@]}"; do write_secret "$name"; done

# Ed25519 receipt pair: Codex signs the verification receipt, Victoria verifies
# it independently. The preflight compares the derived public keys in DER form.
private_key="$RONOR_AUTOMATION_SECRET_DIR/codex_receipt_private_key"
public_key="$RONOR_AUTOMATION_SECRET_DIR/assurance_receipt_public_key"
if [[ -e "$private_key" || -e "$public_key" ]]; then
  skip 'receipt key pair (left untouched)'
else
  openssl genpkey -algorithm ed25519 -out "$private_key" >/dev/null 2>&1
  openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
  info 'receipt key pair generated (Ed25519)'
fi

# The 11th token is NOT generated. automation-preflight.sh line 32 requires 11
# pairwise-distinct service tokens; a random value here would satisfy the
# uniqueness check and then fail at the first real model call. This must be the
# approved upstream gateway key, supplied by the operator.
MISSING_UPSTREAM=0
upstream="$RONOR_AUTOMATION_SECRET_DIR/model_gateway_upstream_token"
if [[ -s "$upstream" ]]; then
  skip 'secret model_gateway_upstream_token (operator supplied)'
else
  MISSING_UPSTREAM=1
  printf 'ACTION     write the approved gateway key yourself, then re-run:\n'
  printf '           printf %%s '"'"'<portkey-or-gateway-key>'"'"' > %s\n' "$upstream"
fi

# Owner-readable, never group-writable, never world-anything: satisfies the
# preflight mask check (mode & 0137 == 0) and stays readable by uid 10001.
find "$RONOR_AUTOMATION_SECRET_DIR" -maxdepth 1 -type f -exec chown "$SERVICE_UID:$SERVICE_GID" {} + \
  -exec chmod 0640 {} +

# ---------------------------------------------------------------- worktree ---
# A dedicated clone, not the deployment checkout: the runner mounts it and the
# preflight requires a self-contained Git root on an automation/* branch,
# pinned to the approved commit and clean.
if [[ -d "$RONOR_AUTOMATION_WORKTREE/.git" ]]; then
  skip "worktree $RONOR_AUTOMATION_WORKTREE"
else
  parent="$(dirname -- "$RONOR_AUTOMATION_WORKTREE")"
  mkdir -p -- "$parent"
  git clone --no-checkout -- "$RONOR_AUTOMATION_EXPECTED_ORIGIN" "$RONOR_AUTOMATION_WORKTREE"
  info "worktree cloned from $RONOR_AUTOMATION_EXPECTED_ORIGIN"
fi

git -C "$RONOR_AUTOMATION_WORKTREE" fetch --quiet origin
git -C "$RONOR_AUTOMATION_WORKTREE" checkout --quiet -B "$RONOR_AUTOMATION_BRANCH" "$RONOR_AUTOMATION_BASE_COMMIT"
git -C "$RONOR_AUTOMATION_WORKTREE" clean -qfdx
chown -R "$SERVICE_UID:$SERVICE_GID" -- "$RONOR_AUTOMATION_WORKTREE"
info "worktree on $RONOR_AUTOMATION_BRANCH at $(git -C "$RONOR_AUTOMATION_WORKTREE" rev-parse --short HEAD)"

if (( MISSING_UPSTREAM )); then
  printf '\nBOOTSTRAP INCOMPLETE\n'
  printf 'BLOCKED    model_gateway_upstream_token is missing.\n'
  printf '           automation-preflight.sh line 32 requires 11 pairwise-distinct\n'
  printf '           service tokens. Only 10 exist. Preflight WILL fail at\n'
  printf '           "service tokens are pairwise distinct".\n'
  printf '           Do not run preflight yet. Write the approved gateway key:\n'
  printf '             printf %%s '"'"'<portkey-key>'"'"' > %s\n' "$upstream"
  printf '             chown %s:%s %s\n' "$SERVICE_UID" "$SERVICE_GID" "$upstream"
  printf '             chmod 0640 %s\n' "$upstream"
  printf '           Then re-run this script.\n'
  exit 3
fi

printf '\nBOOTSTRAP COMPLETE\n'
printf 'Next: export RONOR_AUTOMATION_EXPECTED_HEAD=%s\n' "$(git -C "$RONOR_AUTOMATION_WORKTREE" rev-parse HEAD)"
printf '      export RONOR_AUTOMATION_ENV_FILE=<path to .env.automation>\n'
printf '      bash scripts/automation-preflight.sh\n'
