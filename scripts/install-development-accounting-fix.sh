#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || exit 2
revision="${2:?full reviewed revision required}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/environment" && -f "$root/verification-fix.env" && -f "$root/controller-fix.env" ]] || exit 2
[[ ! -e "$root/accounting-fix.env" ]] || { echo 'accounting_overlay_already_exists; review_required' >&2; exit 2; }
verification_source="$root/releases/dac8833ce2b1be4667f20bb30c7ffd2d5c7181ec"
controller_source="$root/releases/7b5c719191546ef8e7d834ab739189cb9de183fb"
[[ "$(sed -n 's/^RONOR_VERIFICATION_FIX_SOURCE=//p' "$root/verification-fix.env")" == "$verification_source" ]] || exit 2
[[ "$(sed -n 's/^RONOR_CONTROLLER_FIX_SOURCE=//p' "$root/controller-fix.env")" == "$controller_source" ]] || exit 2
phase=preflight
trap 'echo "accounting_fix_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077
containers() { docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort; }
untouched() { sed -E '/^ronor-development-(controller |openhands-bridge-1 |codex-verifier-1 )/d'; }
before="$(containers)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
snapshot() {
  docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/check-development-accounting-update.cjs"
}
before_state="$(snapshot)"
export RONOR_ACCOUNTING_FIX_SOURCE="$source_dir" RONOR_ACCOUNTING_FIX_TAG="$revision"
compose=(docker compose --project-name ronor-development
  --env-file "$root/environment" --env-file "$root/verification-fix.env" --env-file "$root/controller-fix.env"
  -f "$root/tooling/docker-compose.development-isolated.yml"
  -f "$verification_source/docker-compose.development-verification-fix.yml"
  -f "$controller_source/docker-compose.development-controller-fix.yml"
  -f "$source_dir/docker-compose.development-accounting-fix.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build controller openhands-bridge codex-verifier
phase=recheck
[[ "$(snapshot)" == "$before_state" ]]
[[ "$(containers)" == "$before" ]]
phase=replace-three-services
"${compose[@]}" up -d --no-deps --no-build --wait controller openhands-bridge codex-verifier
phase=verify
after="$(containers)"
[[ "$(printf '%s\n' "$before" | untouched)" == "$(printf '%s\n' "$after" | untouched)" ]]
[[ "$(snapshot)" == "$before_state" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker inspect ronor-development-openhands-bridge-1 --format '{{.Config.Image}}')" == "ronor-accounting-runtime:$revision" ]]
[[ "$(docker inspect ronor-development-codex-verifier-1 --format '{{.Config.Image}}')" == "ronor-accounting-runtime:$revision" ]]
phase=record
printf 'RONOR_ACCOUNTING_FIX_SOURCE=%s\nRONOR_ACCOUNTING_FIX_TAG=%s\n' "$source_dir" "$revision" > "$root/accounting-fix.env"
printf '%s\n' "$before_state" > "$source_dir/accounting-preserved-state.json"
printf '%s\n' "$before" > "$source_dir/accounting-containers-before.txt"
printf '%s\n' "$after" > "$source_dir/accounting-containers-after.txt"
echo 'accounting_fix_installed; mandate_and_patch_preserved; no_model_or_job_started'
