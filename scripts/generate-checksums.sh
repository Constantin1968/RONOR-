#!/usr/bin/env bash
# RONOR — Release Checksum Generator
# Generates SHA-256 checksums for release artifacts.
# Usage: ./scripts/generate-checksums.sh [version]

set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUTDIR="release-artifacts"

echo "=== RONOR Release Checksum Generator ==="
echo "Version: ${VERSION}"
echo ""

# Ensure build is current
echo "[1/4] Building..."
npm run build

# Create release archive
echo "[2/4] Creating archive..."
mkdir -p "${OUTDIR}"
tar -czf "${OUTDIR}/ronor-v${VERSION}.tar.gz" \
  dist/ \
  package.json \
  package-lock.json \
  Dockerfile \
  docker-compose.yml \
  src/governance/policies.yaml \
  web/

# Generate checksums
echo "[3/4] Generating checksums..."
cd "${OUTDIR}"
sha256sum *.tar.gz > SHA256SUMS.txt

# Display
echo "[4/4] Complete."
echo ""
cat SHA256SUMS.txt
echo ""
echo "Artifacts in: ${OUTDIR}/"
