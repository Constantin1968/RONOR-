#!/usr/bin/env bash
set -Eeuo pipefail

# READ-ONLY automation activation audit. It never creates networks, files,
# containers or credentials and never prints secret material.
umask 077

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }
need() { command -v "$1" >/dev/null 2>&1 || { fail "required command: $1"; return 1; }; }

for command in docker git openssl sha256sum stat realpath cmp; do need "$command" || true; done
if (( failures > 0 )); then exit 1; fi

: "${RONOR_AUTOMATION_SECRET_DIR:?set RONOR_AUTOMATION_SECRET_DIR}"
: "${RONOR_AUTOMATION_WORKTREE:?set RONOR_AUTOMATION_WORKTREE}"
: "${RONOR_AUTOMATION_EXPECTED_ORIGIN:?set RONOR_AUTOMATION_EXPECTED_ORIGIN}"
: "${RONOR_AUTOMATION_EXPECTED_HEAD:?set RONOR_AUTOMATION_EXPECTED_HEAD}"
: "${RONOR_AUTOMATION_ENV_FILE:?set RONOR_AUTOMATION_ENV_FILE}"

secret_dir="$(realpath -e -- "$RONOR_AUTOMATION_SECRET_DIR")"
worktree="$(realpath -e -- "$RONOR_AUTOMATION_WORKTREE")"
env_file="$(realpath -e -- "$RONOR_AUTOMATION_ENV_FILE")"
repo_root="$(git rev-parse --show-toplevel)"

required_secrets=(
  langgraph_token openhands_session_key openhands_llm_api_key openhands_secret_key
  openhands_bridge_token automation_capability_key codex_verifier_token codex_api_key
  model_gateway_upstream_token assurance_token evidence_runner_token codex_receipt_private_key assurance_receipt_public_key
)
token_secrets=(langgraph_token openhands_session_key openhands_llm_api_key openhands_secret_key openhands_bridge_token automation_capability_key codex_verifier_token codex_api_key model_gateway_upstream_token assurance_token evidence_runner_token)

declare -A token_digests=()
for name in "${required_secrets[@]}"; do
  target="$secret_dir/$name"
  if [[ ! -f "$target" || -L "$target" || ! -r "$target" || ! -s "$target" ]]; then fail "secret file $name is a readable non-link regular file"; continue; fi
  mode="$(stat -c '%a' -- "$target")"; permission=$((8#$mode))
  if (( (permission & 8#137) != 0 || (permission & 8#400) == 0 )); then fail "secret file $name permissions are owner-readable and no broader than 0640"; else pass "secret file $name present with bounded permissions"; fi
done

for name in "${token_secrets[@]}"; do
  target="$secret_dir/$name"; [[ -r "$target" ]] || continue
  digest="$(sha256sum -- "$target" | cut -d' ' -f1)"
  if [[ -n "${token_digests[$digest]:-}" ]]; then fail "service tokens are pairwise distinct"; else token_digests[$digest]="$name"; fi
done
if ((${#token_digests[@]} == ${#token_secrets[@]})); then pass "service tokens are pairwise distinct"; fi

if cmp -s \
  <(openssl pkey -in "$secret_dir/codex_receipt_private_key" -pubout -outform DER 2>/dev/null) \
  <(openssl pkey -pubin -in "$secret_dir/assurance_receipt_public_key" -outform DER 2>/dev/null); then
  pass "Codex private key matches Victoria public key"
else fail "Codex/Victoria Ed25519 key pair matches"; fi

for spec in 'ronor-automation-control:true' 'ronor-model-egress:true' 'ronor-model-uplink:false'; do
  network="${spec%%:*}"; expected="${spec##*:}"
  actual="$(docker network inspect --format '{{.Internal}}' "$network" 2>/dev/null || true)"
  if [[ "$actual" == "$expected" ]]; then pass "network $network internal=$expected"; else fail "network $network exists with internal=$expected"; fi
done

top="$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null || true)"
branch="$(git -C "$worktree" branch --show-current 2>/dev/null || true)"
origin="$(git -C "$worktree" remote get-url origin 2>/dev/null || true)"
head="$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)"
dirty="$(git -C "$worktree" status --porcelain=v1 --untracked-files=all 2>/dev/null || true)"
[[ "$top" == "$worktree" ]] && pass 'worktree is a self-contained Git root' || fail 'worktree is a self-contained Git root'
[[ "$branch" != main && "$branch" != master && "$branch" == automation/* ]] && pass 'worktree uses the automation branch namespace' || fail 'worktree uses the automation branch namespace'
[[ "$origin" == "$RONOR_AUTOMATION_EXPECTED_ORIGIN" ]] && pass 'worktree origin matches policy' || fail 'worktree origin matches policy'
[[ "$head" == "$RONOR_AUTOMATION_EXPECTED_HEAD" ]] && pass 'worktree HEAD matches the approved commit' || fail 'worktree HEAD matches the approved commit'
[[ -z "$dirty" ]] && pass 'worktree starts clean' || fail 'worktree starts clean'

if docker compose --env-file "$env_file" -f "$repo_root/docker-compose.automation.yml" config --quiet >/dev/null; then
  pass 'automation Compose resolves without starting services'
else
  fail 'automation Compose resolves without starting services'
fi

if (( failures > 0 )); then printf 'PREFLIGHT FAIL (%d checks)\n' "$failures" >&2; exit 1; fi
printf 'PREFLIGHT PASS\n'
