#!/usr/bin/env bash
# RONOR — Source Checksum Generator
# Emits SHA-256 digests for every git-tracked file, excluding the checksum
# file itself, in deterministic (git-sorted) path order.
# Usage: bash scripts/generate-source-checksums.sh
# Prepared by AMB.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="checksums.sha256"
TMP="$(mktemp)"

git ls-files -z \
  | tr '\0' '\n' \
  | grep -v -x "${OUT}" \
  | LC_ALL=C sort \
  | while IFS= read -r f; do
      [ -f "$f" ] && sha256sum "$f"
    done > "${TMP}"

COUNT=$(wc -l < "${TMP}")
ROLLUP=$(awk '{print $1}' "${TMP}" | sha256sum | awk '{print $1}')

{
  echo "# RONOR — SHA-256 Source Checksums"
  echo "# Release:     v0.4.0-core-active"
  echo "# Commit:      $(git rev-parse HEAD)"
  echo "# Generated:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Files:       ${COUNT}"
  echo "# Algorithm:   SHA-256 (coreutils sha256sum)"
  echo "# Rollup:      ${ROLLUP}"
  echo "#              (SHA-256 of the concatenated per-file digest column)"
  echo "# Verify:      grep -v '^#' checksums.sha256 | sha256sum -c -"
  echo "# Prepared by AMB"
  cat "${TMP}"
} > "${OUT}"

rm -f "${TMP}"

echo "wrote ${OUT}"
echo "  files:  ${COUNT}"
echo "  rollup: ${ROLLUP}"
