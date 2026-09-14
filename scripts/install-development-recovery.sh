#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || exit 2
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
for file in environment verification-fix.env controller-fix.env accounting-fix.env budget.env; do
  [[ -f "$root/$file" ]] || exit 2
done
[[ ! -e "$root/recovery-fix.env" ]] || { echo recovery_overlay_exists_review_required >&2; exit 2; }
verification_source="$(sed -n 's/^RONOR_VERIFICATION_FIX_SOURCE=//p' "$root/verification-fix.env")"
controller_source="$(sed -n 's/^RONOR_CONTROLLER_FIX_SOURCE=//p' "$root/controller-fix.env")"
accounting_source="$(sed -n 's/^RONOR_ACCOUNTING_FIX_SOURCE=//p' "$root/accounting-fix.env")"
budget_source="$(sed -n 's/^RONOR_BUDGET_SOURCE=//p' "$root/budget.env")"
for value in "$verification_source" "$controller_source" "$accounting_source" "$budget_source"; do
  [[ "$value" =~ ^/srv/ronor/development-automation/releases/[a-f0-9]{40}$ ]] || exit 2
done
phase=preflight
trap 'echo "recovery_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077
containers() { docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort; }
untouched() { sed -E '/^ronor-development-(controller |openhands-bridge-1 )/d'; }
snapshot() { docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/check-development-accounting-update.cjs"; }
before="$(containers)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
before_state="$(snapshot)"
export RONOR_RECOVERY_FIX_SOURCE="$source_dir" RONOR_RECOVERY_FIX_TAG="$revision"
compose=(docker compose --project-name ronor-development
  --env-file "$root/environment" --env-file "$root/verification-fix.env" --env-file "$root/controller-fix.env"
  --env-file "$root/accounting-fix.env" --env-file "$root/budget.env"
  -f "$root/tooling/docker-compose.development-isolated.yml"
  -f "$verification_source/docker-compose.development-verification-fix.yml"
  -f "$controller_source/docker-compose.development-controller-fix.yml"
  -f "$accounting_source/docker-compose.development-accounting-fix.yml"
  -f "$budget_source/docker-compose.development-budget.yml"
  -f "$source_dir/docker-compose.development-recovery.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build controller openhands-bridge
phase=recheck
[[ "$(snapshot)" == "$before_state" && "$(containers)" == "$before" ]]
phase=replace-two-services
"${compose[@]}" up -d --no-deps --no-build --wait controller openhands-bridge
phase=verify
after="$(containers)"
[[ "$(printf '%s\n' "$before" | untouched)" == "$(printf '%s\n' "$after" | untouched)" ]]
[[ "$(snapshot)" == "$before_state" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker inspect ronor-development-openhands-bridge-1 --format '{{.Config.Image}}')" == "ronor-recovery-runtime:$revision" ]]
phase=record
printf 'RONOR_RECOVERY_FIX_SOURCE=%s\nRONOR_RECOVERY_FIX_TAG=%s\n' "$source_dir" "$revision" > "$root/recovery-fix.env"
printf '%s\n' "$before_state" > "$source_dir/recovery-preserved-state.json"
printf '%s\n' "$before" > "$source_dir/recovery-containers-before.txt"
printf '%s\n' "$after" > "$source_dir/recovery-containers-after.txt"
echo 'recovery_code_installed; original_state_and_patch_preserved; no_reauthorization_or_model_started'
