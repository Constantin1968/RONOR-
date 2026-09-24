#!/usr/bin/env bash
# Authorized 2026-09-08: set a 100 USD per-run maximum and preserve the exact
# recovered worker patch. No push, history rewrite, ledger change or model call.
set -Eeuo pipefail
[[ "${1:-}" == --approved-100 ]] || exit 2
root=/srv/ronor/development-automation
[[ "$(id -u)" == 0 ]] || exit 2
umask 077
phase=preflight
trap 'echo "repair_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence="$root/maintenance/ceiling-100-$stamp"
mkdir -p "$evidence"
source_dir="$(sed -n 's/^RONOR_WIREFIX_SOURCE=//p' "$root/wirefix.env")"
[[ "$source_dir" =~ ^/srv/ronor/development-automation/releases/[a-f0-9]{40}$ ]]
snapshot() {
  docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - \
    < "$source_dir/scripts/capture-development-state.cjs"
}
containers() {
  docker ps -a --filter label=com.docker.compose.project=ronor-development \
    --format '{{.Names}} {{.ID}}' | sort
}
before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1)"
[[ "$(awk '/^RONOR_AUTOMATION_MAX_COST_USD=/{print $0}' "$root/environment")" == RONOR_AUTOMATION_MAX_COST_USD=1 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 1 ]]
[[ "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" == ' M tests/runtime/development-controller.test.ts' ]]
docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller \
  git -C /automation-worktrees/project diff --binary > "$evidence/recovered-worker.diff"
[[ "$(sha256sum "$evidence/recovered-worker.diff" | cut -d' ' -f1)" == 9c5be32a18bd63c6e76ac945e6d141b698469ee244cce36f0ba490bdf07d9922 ]]

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env wirefix.env; do
  [[ -f "$root/$name" ]]
  compose+=(--env-file "$root/$name")
done
files="$(docker inspect ronor-development-controller --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
IFS=, read -ra config_files <<< "$files"
[[ "${#config_files[@]}" == 7 ]]
for file in "${config_files[@]}"; do
  [[ "$file" == "$root/"* && -f "$file" ]]
  compose+=(-f "$file")
done
"${compose[@]}" config --quiet
phase=change-ceiling
backup="/root/ronor-ops-backups/ceiling-100-$stamp"
mkdir -p "$backup"
cp -p "$root/environment" "$backup/environment"
sed -i 's/^RONOR_AUTOMATION_MAX_COST_USD=1$/RONOR_AUTOMATION_MAX_COST_USD=100/' "$root/environment"
"${compose[@]}" config --quiet
[[ "$(snapshot)" == "$before" ]]
phase=recreate-controller-only
"${compose[@]}" up -d --no-deps --no-build --wait controller
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ "$(snapshot)" == "$before" ]]
[[ "$(containers | sed '/^ronor-development-controller /d')" == "$(printf '%s\n' "$before_containers" | sed '/^ronor-development-controller /d')" ]]
[[ "$(sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1)" == "$before_ledger" ]]
phase=preserve-worker-test
docker exec -i ronor-development-openhands-agent-1 sh -s <<'REMOTE'
set -eu
cd /workspace/project
test "$(git branch --show-current)" = automation/development-001
test "$(git status --porcelain)" = ' M tests/runtime/development-controller.test.ts'
test "$(git diff --binary | sha256sum | cut -d' ' -f1)" = 9c5be32a18bd63c6e76ac945e6d141b698469ee244cce36f0ba490bdf07d9922
git diff --check
git add -- tests/runtime/development-controller.test.ts
git -c user.name='RONOR recovery operator' -c user.email=ops@ronor.local \
  commit -m 'tests: preserve the autonomous empty-objective regression test' \
  -m 'Recovered from run_4fa94a9f0481d4d65c54 after its budget refusal. Exact diff archived before this operator-assisted commit. No claim of autonomous completion.'
test -z "$(git status --porcelain)"
REMOTE
phase=record
printf '%s\n' "$before" > "$evidence/state-before.json"
snapshot > "$evidence/state-after.json"
printf '%s\n' "$before_containers" > "$evidence/containers-before.txt"
containers > "$evidence/containers-after.txt"
printf 'old_ceiling_usd=1\nnew_ceiling_usd=100\nledger_sha256_unchanged=%s\n' "$before_ledger" > "$evidence/change.txt"
echo "ceiling_100_applied; worktree_clean; worker_test_committed; other_seven_containers_unchanged; evidence=$evidence"
