#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || exit 2
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/environment" && -f "$root/verification-fix.env" && -f "$root/controller-fix.env" && -f "$root/accounting-fix.env" ]] || exit 2
[[ ! -e "$root/budget.env" && ! -e "$root/model-budget" ]] || { echo 'budget_install_exists_review_required' >&2; exit 2; }
verification_source="$(sed -n 's/^RONOR_VERIFICATION_FIX_SOURCE=//p' "$root/verification-fix.env")"
controller_source="$(sed -n 's/^RONOR_CONTROLLER_FIX_SOURCE=//p' "$root/controller-fix.env")"
accounting_source="$root/releases/ac3e22c27fbf51cd1910e71974253779981e8098"
[[ "$verification_source" =~ ^/srv/ronor/development-automation/releases/[a-f0-9]{40}$ &&
   "$controller_source" =~ ^/srv/ronor/development-automation/releases/[a-f0-9]{40}$ ]] || exit 2
[[ "$(sed -n 's/^RONOR_ACCOUNTING_FIX_SOURCE=//p' "$root/accounting-fix.env")" == "$accounting_source" ]] || exit 2
phase=preflight
trap 'echo "budget_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077
containers() { docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort; }
untouched() { sed -E '/^ronor-development-(controller |openhands-bridge-1 |codex-verifier-1 |model-egress-proxy-1 )/d'; }
snapshot() {
  docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/check-development-accounting-update.cjs"
}
before="$(containers)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
before_state="$(snapshot)"
docker exec ronor-development-openhands-bridge-1 node -e 'const {requiredSecret:r}=require("/app/dist/runtime/automation/services/secret-files.js");if(r("RONOR_OPENHANDS_LLM_MODEL")!=="openai/qwen3.8-max")process.exit(2)'
docker exec ronor-development-codex-verifier-1 node -e 'const {requiredSecret:r}=require("/app/dist/runtime/automation/services/secret-files.js");if(r("RONOR_CODEX_MODEL")!=="qwen3.8-max")process.exit(2)'
docker exec ronor-development-model-egress-proxy-1 node -e 'const {requiredSecret:r}=require("/app/dist/runtime/automation/services/secret-files.js");if(new URL(r("RONOR_MODEL_GATEWAY_BASE_URL")).hostname!=="dashscope-intl.aliyuncs.com")process.exit(2)'
export RONOR_BUDGET_SOURCE="$source_dir" RONOR_BUDGET_TAG="$revision"
compose=(docker compose --project-name ronor-development
  --env-file "$root/environment" --env-file "$root/verification-fix.env" --env-file "$root/controller-fix.env" --env-file "$root/accounting-fix.env"
  -f "$root/tooling/docker-compose.development-isolated.yml"
  -f "$verification_source/docker-compose.development-verification-fix.yml"
  -f "$controller_source/docker-compose.development-controller-fix.yml"
  -f "$accounting_source/docker-compose.development-accounting-fix.yml"
  -f "$source_dir/docker-compose.development-budget.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build controller openhands-bridge codex-verifier model-egress-proxy
phase=recheck
[[ "$(snapshot)" == "$before_state" && "$(containers)" == "$before" ]]
phase=budget-storage
install -d -m 0700 -o 10001 -g 10001 "$root/model-budget"
phase=replace-four-services
"${compose[@]}" up -d --no-deps --no-build --wait controller openhands-bridge codex-verifier model-egress-proxy
phase=verify
after="$(containers)"
[[ "$(printf '%s\n' "$before" | untouched)" == "$(printf '%s\n' "$after" | untouched)" ]]
[[ "$(snapshot)" == "$before_state" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
for container in ronor-development-openhands-bridge-1 ronor-development-codex-verifier-1 ronor-development-model-egress-proxy-1; do
  [[ "$(docker inspect "$container" --format '{{.Config.Image}}')" == "ronor-budget-runtime:$revision" ]]
done
phase=record
printf 'RONOR_BUDGET_SOURCE=%s\nRONOR_BUDGET_TAG=%s\n' "$source_dir" "$revision" > "$root/budget.env"
printf '%s\n' "$before_state" > "$source_dir/budget-preserved-state.json"
printf '%s\n' "$before" > "$source_dir/budget-containers-before.txt"
printf '%s\n' "$after" > "$source_dir/budget-containers-after.txt"
echo 'budget_reservations_installed; state_and_patch_preserved; no_model_started'
