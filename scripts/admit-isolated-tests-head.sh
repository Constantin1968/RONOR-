#!/usr/bin/env bash
# Admit the operator-assisted test-isolation commit. Strict equality admission is
# preserved; only the expected head changes. No model call, push or history rewrite.
set -Eeuo pipefail
[[ "${1:-}" == --approved-admission ]] || exit 2
head="${2:?new head}"
old="${3:?old head}"
[[ "$head" =~ ^[a-f0-9]{40}$ && "$old" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
umask 077
phase=preflight
trap 'echo "admission_failed_phase=$phase; stopped_without_retry" >&2' ERR
W="$root/worktree"
G=(git -c "safe.directory=$W" -C "$W")
source_dir="$(sed -n 's/^RONOR_TRANSPORT_SOURCE=//p' "$root/transport.env")"
[[ -d "$source_dir" ]]
snapshot() { docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/capture-development-state.cjs"; }
ledger() { sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1; }
before="$(snapshot)"
before_ledger="$(ledger)"
[[ "$("${G[@]}" rev-parse HEAD)" == "$head" ]]
[[ -z "$("${G[@]}" status --porcelain)" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_EXPECTED_HEAD=//p' "$root/environment")" == "$old" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]
others() {
  docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' |
    sed -E '/^ronor-development-(controller |automation-evidence-runner-1 )/d' | sort
}
before_others="$(others)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/ronor-ops-backups/admit-head-$stamp"
evidence="$root/maintenance/admit-head-$stamp"
mkdir -p "$backup" "$evidence"
cp -p "$root/environment" "$backup/environment"
printf '%s\n' "$before" > "$evidence/before.json"
phase=rewrite-expected-head
sed -i "s/^RONOR_AUTOMATION_EXPECTED_HEAD=$old\$/RONOR_AUTOMATION_EXPECTED_HEAD=$head/" "$root/environment"
[[ "$(sed -n 's/^RONOR_AUTOMATION_EXPECTED_HEAD=//p' "$root/environment")" == "$head" ]]
compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env wirefix.env transport.env; do
  [[ -f "$root/$name" ]]
  compose+=(--env-file "$root/$name")
done
files="$(docker inspect ronor-development-controller --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
IFS=, read -ra config_files <<< "$files"
[[ "${#config_files[@]}" == 8 ]]
for file in "${config_files[@]}"; do
  [[ -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_TRANSPORT_SOURCE="$source_dir" RONOR_TRANSPORT_TAG="$(sed -n 's/^RONOR_TRANSPORT_TAG=//p' "$root/transport.env")"
"${compose[@]}" config --quiet
phase=recreate-controller-and-evidence
"${compose[@]}" up -d --no-deps --no-build --wait controller automation-evidence-runner
phase=verify
[[ "$(snapshot)" == "$before" ]]
[[ "$(others)" == "$before_others" ]]
[[ "$(ledger)" == "$before_ledger" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_EXPECTED_HEAD)" == "$head" ]]
[[ "$(docker exec ronor-development-automation-evidence-runner-1 printenv RONOR_AUTOMATION_EXPECTED_HEAD)" == "$head" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
snapshot > "$evidence/after.json"
printf 'old_expected_head=%s\nnew_expected_head=%s\nledger_sha256_unchanged=%s\nceiling_usd=100\n' \
  "$old" "$head" "$before_ledger" > "$evidence/change.txt"
echo "isolated_tests_head_admitted; common_evidence_baseline; state_and_ledger_unchanged; six_other_containers_unchanged; evidence=$evidence"
