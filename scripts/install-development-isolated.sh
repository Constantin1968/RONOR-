#!/usr/bin/env bash
# Execute ONLY after explicit deployment approval for this target and snapshot.
set -Eeuo pipefail
umask 077
stage=preconditions
trap 'printf "INSTALL_STOPPED stage=%s line=%s\n" "$stage" "$LINENO" >&2' ERR
root=/srv/ronor/development-automation
archive="${1:?snapshot archive required}"
expected="${2:?approved exact commit required}"
[[ "$expected" =~ ^[a-f0-9]{40}$ ]]
[[ "$(id -u)" == 0 ]]
[[ ! -e "$root" ]]
[[ -f "$archive" ]]
[[ -r /srv/ronor/automation/secrets/model_gateway_upstream_token ]]
[[ "$(docker network inspect -f '{{.Internal}}' ronor-model-uplink)" == false ]]
[[ -z "$(ss -ltnH '( sport = :3010 or sport = :3301 or sport = :3302 or sport = :3303 or sport = :3324 )')" ]]
[[ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -ge 12000 ]]
! docker inspect ronor-development-controller >/dev/null 2>&1

stage=isolated_snapshot
mkdir -m 0750 "$root"
mkdir -m 0750 "$root/tooling"
tar --extract --gzip --file "$archive" --directory "$root/tooling" --no-same-owner
[[ "$(git -C "$root/tooling" rev-parse HEAD)" == "$expected" ]]
[[ -z "$(git -C "$root/tooling" status --porcelain)" ]]
[[ "$(git -C "$root/tooling" remote get-url origin)" == https://github.com/Constantin1968/RONOR-.git ]]
cp -a "$root/tooling" "$root/worktree"
git -C "$root/worktree" switch -c automation/development-001
git -C "$root/worktree" config --local user.name 'RONOR Development Worker'
git -C "$root/worktree" config --local user.email 'ronor-development@localhost'
mkdir -m 0700 "$root/secrets" "$root/artifacts" "$root/nonces" "$root/data" "$root/dependencies"
mkdir -p "$root/worktree/node_modules"
chown -hR 10001:10001 "$root/worktree" "$root/secrets" "$root/artifacts" "$root/nonces" "$root/data" "$root/dependencies"

stage=service_identities
for name in development_architect_key development_mandate_key langgraph_token \
  openhands_session_key openhands_llm_api_key openhands_secret_key \
  openhands_bridge_token automation_capability_key codex_verifier_token \
  codex_api_key assurance_token evidence_runner_token; do
  openssl rand -hex 32 > "$root/secrets/$name"
done
openssl genpkey -algorithm ED25519 -out "$root/secrets/codex_receipt_private_key"
openssl pkey -in "$root/secrets/codex_receipt_private_key" -pubout -out "$root/secrets/assurance_receipt_public_key"
chown 10001:10001 "$root"/secrets/*
chmod 0600 "$root"/secrets/*

stage=validated_configuration
cp "$root/tooling/.env.development.example" "$root/environment"
sed -i "s/__REVISION__/${expected:0:12}/g;s/__COMMIT__/$expected/g" "$root/environment"
compose=(docker compose --project-name ronor-development --env-file "$root/environment" -f "$root/tooling/docker-compose.development-isolated.yml")
"${compose[@]}" config --quiet

stage=build
"${compose[@]}" build
stage=dependency_snapshot
dependency_container="ronor-development-dependency-export-${expected:0:12}"
docker create --name "$dependency_container" "ronor-evidence-runner:development-${expected:0:12}" >/dev/null
docker cp "$dependency_container:/app/node_modules/." "$root/dependencies/"
docker rm "$dependency_container" >/dev/null
chown -hR 10001:10001 "$root/dependencies"
[[ -f "$root/dependencies/jest/bin/jest.js" ]]
[[ -f "$root/dependencies/better-sqlite3/build/Release/better_sqlite3.node" ]]
[[ -z "$(git -c safe.directory="$root/worktree" -C "$root/worktree" status --porcelain)" ]]

stage=start_new_stack_only
"${compose[@]}" up -d --no-build --wait --wait-timeout 240
stage=complete
printf 'INSTALL_COMPLETE commit=%s project=ronor-development old_stack=untouched\n' "$expected"
