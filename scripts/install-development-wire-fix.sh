#!/usr/bin/env bash
# Install the admitted-wire-shape fix on exactly three services. Observational
# guarantees: no reauthorization, no model call, no run started, no ledger write.
# Refuses instead of improvising; never retries and never rolls forward.
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || exit 2
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
for file in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env; do
  [[ -f "$root/$file" ]] || { echo "missing_overlay=$file" >&2; exit 2; }
done
[[ ! -e "$root/wirefix.env" ]] || { echo wirefix_overlay_exists_review_required >&2; exit 2; }
verification_source="$(sed -n 's/^RONOR_VERIFICATION_FIX_SOURCE=//p' "$root/verification-fix.env")"
controller_source="$(sed -n 's/^RONOR_CONTROLLER_FIX_SOURCE=//p' "$root/controller-fix.env")"
accounting_source="$(sed -n 's/^RONOR_ACCOUNTING_FIX_SOURCE=//p' "$root/accounting-fix.env")"
budget_source="$(sed -n 's/^RONOR_BUDGET_SOURCE=//p' "$root/budget.env")"
recovery_source="$(sed -n 's/^RONOR_RECOVERY_FIX_SOURCE=//p' "$root/recovery-fix.env")"
for value in "$verification_source" "$controller_source" "$accounting_source" "$budget_source" "$recovery_source"; do
  [[ "$value" =~ ^/srv/ronor/development-automation/releases/[a-f0-9]{40}$ ]] || exit 2
done
phase=preflight
trap 'echo "wirefix_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077
containers() { docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort; }
untouched() { sed -E '/^ronor-development-(controller |openhands-bridge-1 |model-egress-proxy-1 )/d'; }
snapshot() { docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/check-development-accounting-update.cjs"; }
ledger() { sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1; }
before="$(containers)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
before_state="$(snapshot)"
before_ledger="$(ledger)"
export RONOR_WIREFIX_SOURCE="$source_dir" RONOR_WIREFIX_TAG="$revision"
compose=(docker compose --project-name ronor-development
  --env-file "$root/environment" --env-file "$root/verification-fix.env" --env-file "$root/controller-fix.env"
  --env-file "$root/accounting-fix.env" --env-file "$root/budget.env" --env-file "$root/recovery-fix.env"
  -f "$root/tooling/docker-compose.development-isolated.yml"
  -f "$verification_source/docker-compose.development-verification-fix.yml"
  -f "$controller_source/docker-compose.development-controller-fix.yml"
  -f "$accounting_source/docker-compose.development-accounting-fix.yml"
  -f "$budget_source/docker-compose.development-budget.yml"
  -f "$recovery_source/docker-compose.development-recovery.yml"
  -f "$source_dir/docker-compose.development-wirefix.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build controller openhands-bridge model-egress-proxy
phase=recheck
[[ "$(snapshot)" == "$before_state" && "$(containers)" == "$before" && "$(ledger)" == "$before_ledger" ]]
phase=replace-three-services
"${compose[@]}" up -d --no-deps --no-build --wait controller openhands-bridge model-egress-proxy
phase=verify
after="$(containers)"
[[ "$(printf '%s\n' "$before" | untouched)" == "$(printf '%s\n' "$after" | untouched)" ]]
[[ "$(snapshot)" == "$before_state" ]]
[[ "$(ledger)" == "$before_ledger" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker inspect ronor-development-openhands-bridge-1 --format '{{.Config.Image}}')" == "ronor-wirefix-runtime:$revision" ]]
[[ "$(docker inspect ronor-development-model-egress-proxy-1 --format '{{.Config.Image}}')" == "ronor-wirefix-runtime:$revision" ]]
phase=record
printf 'RONOR_WIREFIX_SOURCE=%s\nRONOR_WIREFIX_TAG=%s\n' "$source_dir" "$revision" > "$root/wirefix.env"
printf '%s\n' "$before_state" > "$source_dir/wirefix-preserved-state.json"
printf '%s\n' "$before" > "$source_dir/wirefix-containers-before.txt"
printf '%s\n' "$after" > "$source_dir/wirefix-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/wirefix-ledger-unchanged.txt"
echo 'wirefix_installed; three_services_replaced; ledger_and_run_state_unchanged; no_model_started'
