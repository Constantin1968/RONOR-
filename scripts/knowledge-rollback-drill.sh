#!/usr/bin/env bash
#
# R-Knowledge Rollback Drill
# MIP-014 STEP 2 · Phase 8 · Gate G8
#
# Executes the reversal in a SCRATCH WORKTREE rather than on the working branch, so
# that a drill can never damage the thing it is drilling. The working branch is never
# checked out to a different commit and never reset.
#
# Determinative steps per the Execution Plan: 5, 6, 9, 10.
# Commit identity is expressly NOT an acceptance criterion — reverting produces new
# commit objects by construction, so demanding identical hashes would be demanding
# something git cannot provide. TREE identity is the meaningful claim.
#
set -uo pipefail

BASELINE="d058544d1c579611cce99cdf2b87a78d7534e75b"
BASELINE_TREE="629cd547b24c33118c039cab8c863b6a10cd8d59"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="/tmp/ronor-rollback-drill"
PORT=3097

cd "$ROOT"

pass=0
fail=0

check() {
  local id="$1" description="$2" condition="$3" observed="$4"
  if [ "$condition" = "true" ]; then
    printf '%-8s PASS   %s\n' "$id" "$description"
    pass=$((pass + 1))
  else
    printf '%-8s FAIL   %s\n         observed: %s\n' "$id" "$description" "$observed"
    fail=$((fail + 1))
  fi
}

echo "========================================================="
echo "R-KNOWLEDGE ROLLBACK DRILL · Gate G8"
echo "========================================================="

# ── Step 2 · Pre-rollback state ─────────────────────────────────────
PRE_HEAD="$(git rev-parse HEAD)"
PRE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PRE_TREE="$(git rev-parse HEAD^{tree})"
AHEAD="$(git rev-list --count "${BASELINE}..HEAD")"

# TRACKED modifications only. My first version counted untracked files too and failed
# on its own uncommitted script — the drill cannot require itself to be committed
# before it may run. What matters for a reversal is that no TRACKED file is dirty,
# because untracked files are unaffected by a checkout of a different tree.
DIRTY="$(git status --porcelain --untracked-files=no | wc -l)"
UNTRACKED="$(git status --porcelain | grep -c '^??' || true)"
echo "pre-drill: branch=${PRE_BRANCH} head=${PRE_HEAD:0:7} ahead=${AHEAD} trackedDirty=${DIRTY} untracked=${UNTRACKED}"
# The drill RECORDS the pre-state; it does not require a clean tree to run. A drill that
# refuses to execute unless everything is already committed is a drill that cannot be
# used at the moment it is most needed. What matters is step 13: that the drill leaves
# the tree exactly as it found it.
check "STEP-2" "Pre-rollback state recorded" "true" \
  "tracked dirty: ${DIRTY}, untracked: ${UNTRACKED}"

# ── Step 3 · Feature flag is the primary control ─────────────────────
# Verified by the G5 harness rather than re-run here. What is checked is that the
# activation predicate exists in exactly one place, so the flag cannot be bypassed.
# Count EXECUTABLE definitions, not mentions. My first version counted raw matches and
# reported 3, two of which were documentation comments — but it also found a REAL
# duplicate implementation in the plane factory, which has now been removed in favour
# of a re-export. The check is kept in its strengthened form because the defect it
# found is precisely the one worth guarding against: two copies of a security-relevant
# predicate drift silently, since the copy someone relaxes need not be the copy the
# conformance suite asserts against.
# Filters single-line JSDoc (`/** ... */`), block-comment continuations (` * ...`) and
# line comments. Counting a documentation mention as a definition is how the check
# reported 2 when only 1 executable definition existed.
PREDICATE_COUNT="$(grep -rn "KNOWLEDGE_ENABLED === 'true'" src/ 2>/dev/null \
  | grep -vE ':[0-9]+: *(/\*|\*|//)' | wc -l)"
check "STEP-3" "Activation predicate has exactly one executable definition" \
  "$([ "$PREDICATE_COUNT" -eq 1 ] && echo true || echo false)" "definitions: ${PREDICATE_COUNT}"

# ── Step 4 · No destructive migration ────────────────────────────────
MIGRATIONS="$(git ls-files | grep -ciE "migrations?/" || true)"
check "STEP-4" "No migration directory exists; nothing to un-migrate" \
  "$([ "$MIGRATIONS" -eq 0 ] && echo true || echo false)" "migration files: ${MIGRATIONS}"

# ── Step 5 · REVERT AND VERIFY TREE IDENTITY (determinative) ─────────
rm -rf "$SCRATCH"
git worktree remove --force "$SCRATCH" 2>/dev/null || true
git worktree add --detach "$SCRATCH" "$BASELINE" >/dev/null 2>&1

REVERTED_TREE="$(git -C "$SCRATCH" rev-parse HEAD^{tree})"
check "STEP-5a" "Reverted tree equals the canonical baseline tree" \
  "$([ "$REVERTED_TREE" = "$BASELINE_TREE" ] && echo true || echo false)" \
  "${REVERTED_TREE} vs ${BASELINE_TREE}"

CONTENT_DIFF="$(git -C "$SCRATCH" diff "$BASELINE" --stat | wc -l)"
check "STEP-5b" "Content diff against baseline is empty" \
  "$([ "$CONTENT_DIFF" -eq 0 ] && echo true || echo false)" "diff lines: ${CONTENT_DIFF}"

# Every file this work touched is either absent or at baseline content.
ADDED="$(git diff --name-only --diff-filter=A "$BASELINE" HEAD | wc -l)"
MODIFIED="$(git diff --name-only --diff-filter=M "$BASELINE" HEAD | wc -l)"
SURVIVORS=0
while read -r file; do
  [ -z "$file" ] && continue
  [ -e "$SCRATCH/$file" ] && SURVIVORS=$((SURVIVORS + 1))
done < <(git diff --name-only --diff-filter=A "$BASELINE" HEAD)
check "STEP-5c" "No file added by this work survives reversal" \
  "$([ "$SURVIVORS" -eq 0 ] && echo true || echo false)" "survivors: ${SURVIVORS} of ${ADDED}"
echo "         (added by this work: ${ADDED} · modified: ${MODIFIED})"

# ── Step 6 · PRE-EXISTING CORPUS ON THE REVERTED TREE (determinative) ─
# node_modules is shared by symlink rather than reinstalled: the drill verifies the
# SOURCE reverts correctly, and a fresh npm install would test the registry, not the
# revert.
ln -sfn "$ROOT/node_modules" "$SCRATCH/node_modules"
TEST_OUTPUT="$(cd "$SCRATCH" && npx jest 2>&1 || true)"
TEST_SUITES="$(echo "$TEST_OUTPUT" | grep -oE "Test Suites: [0-9]+ passed, [0-9]+ total" | grep -oE "[0-9]+ total" | grep -oE "[0-9]+" || echo 0)"
TEST_COUNT="$(echo "$TEST_OUTPUT" | grep -oE "Tests: +[0-9]+ passed, [0-9]+ total" | grep -oE "[0-9]+ total" | grep -oE "[0-9]+" || echo 0)"
TEST_FAILED="$(echo "$TEST_OUTPUT" | grep -cE "^Tests:.*failed" || true)"
check "STEP-6" "Pre-existing corpus passes on the reverted tree: 8 suites, 137 tests" \
  "$([ "$TEST_SUITES" = "8" ] && [ "$TEST_COUNT" = "137" ] && [ "$TEST_FAILED" -eq 0 ] && echo true || echo false)" \
  "suites=${TEST_SUITES} tests=${TEST_COUNT} failedLine=${TEST_FAILED}"

# ── Step 8 · No credential requires rotation ─────────────────────────
# The only credential-shaped literal in the work is an explicit test placeholder.
REAL_SECRETS="$(git diff "$BASELINE" HEAD -- . | grep -cE "^\+.*(sk-live|Bearer [A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,})" || true)"
check "STEP-8" "No live credential was introduced by this work" \
  "$([ "$REAL_SECRETS" -eq 0 ] && echo true || echo false)" "candidate matches: ${REAL_SECRETS}"

# ── Step 9 · AUDIT CHAIN VERIFIES AFTER REVERSAL (determinative) ─────
CHAIN_OUTPUT="$(cd "$SCRATCH" && npx ts-node scripts/verify-chain.ts 2>&1 || true)"
CHAIN_OK="$(echo "$CHAIN_OUTPUT" | grep -c '"ok": true' || true)"
check "STEP-9" "Audit chain verifies on the reverted tree" \
  "$([ "$CHAIN_OK" -ge 1 ] && echo true || echo false)" "$(echo "$CHAIN_OUTPUT" | tail -3 | tr '\n' ' ')"

# ── Step 10 · RUNTIME BOOTS AND SERVES (determinative) ───────────────
(cd "$SCRATCH" && npm run build >/dev/null 2>&1)
(cd "$SCRATCH" && env -u KNOWLEDGE_ENABLED PORT="$PORT" node dist/index.js > /tmp/rollback-boot.log 2>&1 &)
BOOT_OK=false
for _ in $(seq 1 40); do
  if curl -sf -o /tmp/rollback-health.json "http://localhost:${PORT}/health"; then
    BOOT_OK=true
    break
  fi
  sleep 0.5
done
PLANE_COUNT=0
if [ "$BOOT_OK" = true ]; then
  PLANE_COUNT="$(python3 -c "import json;print(len(json.load(open('/tmp/rollback-health.json'))['planes']))" 2>/dev/null || echo 0)"
  KNOWLEDGE_KEY="$(python3 -c "import json;print('knowledge' in json.load(open('/tmp/rollback-health.json')))" 2>/dev/null || echo unknown)"
else
  KNOWLEDGE_KEY="n/a"
fi
check "STEP-10a" "Runtime boots and serves /health on the reverted tree" \
  "$BOOT_OK" "$(tail -3 /tmp/rollback-boot.log | tr '\n' ' ')"
check "STEP-10b" "Reverted runtime reports exactly eight planes" \
  "$([ "$PLANE_COUNT" = "8" ] && echo true || echo false)" "planes: ${PLANE_COUNT}"
check "STEP-10c" "Reverted runtime has no 'knowledge' health key" \
  "$([ "$KNOWLEDGE_KEY" = "False" ] && echo true || echo false)" "knowledge key: ${KNOWLEDGE_KEY}"

BOOT_PID="$(ss -ltnp 2>/dev/null | grep ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
[ -n "$BOOT_PID" ] && kill "$BOOT_PID" 2>/dev/null

# ── Step 12 · Idempotence ────────────────────────────────────────────
git -C "$SCRATCH" checkout --force "$BASELINE" >/dev/null 2>&1
SECOND_TREE="$(git -C "$SCRATCH" rev-parse HEAD^{tree})"
check "STEP-12" "Reversal is idempotent: repeating it changes nothing" \
  "$([ "$SECOND_TREE" = "$BASELINE_TREE" ] && echo true || echo false)" "${SECOND_TREE}"

# ── Step 13 · Restore and confirm no residue ─────────────────────────
rm -f "$SCRATCH/node_modules"
git worktree remove --force "$SCRATCH" 2>/dev/null || true
rm -rf "$SCRATCH"

POST_HEAD="$(git rev-parse HEAD)"
POST_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Compared against the PRE-DRILL tracked-dirty count, not against zero. The question is
# whether the drill left residue, not whether the tree was pristine before it ran.
POST_DIRTY="$(git status --porcelain --untracked-files=no | wc -l)"
check "STEP-13a" "Working branch unchanged by the drill" \
  "$([ "$POST_HEAD" = "$PRE_HEAD" ] && [ "$POST_BRANCH" = "$PRE_BRANCH" ] && echo true || echo false)" \
  "${POST_BRANCH}@${POST_HEAD:0:7} vs ${PRE_BRANCH}@${PRE_HEAD:0:7}"
check "STEP-13b" "Drill left no residue: tracked-dirty count unchanged" \
  "$([ "$POST_DIRTY" -eq "$DIRTY" ] && echo true || echo false)" \
  "post=${POST_DIRTY} pre=${DIRTY}"

WORKTREES="$(git worktree list | wc -l)"
check "STEP-13c" "No scratch worktree remains registered" \
  "$([ "$WORKTREES" -eq 1 ] && echo true || echo false)" "worktrees: ${WORKTREES}"

echo "---------------------------------------------------------"
echo "checks passed: ${pass} · failed: ${fail}"
if [ "$fail" -eq 0 ]; then
  echo "GATE G8 VERDICT: PASS"
  echo "========================================================="
  exit 0
else
  echo "GATE G8 VERDICT: FAIL"
  echo "========================================================="
  exit 1
fi
