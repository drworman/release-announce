#!/usr/bin/env bash
# scripts/verify_release.sh — verify a signed release artifact
#
# Usage:
#   bash verify_release.sh <artifact>
#   bash verify_release.sh myproject-1.0.tar.gz
#
# Checks:
#   1. SHA-256 checksum matches the published .sha256 file
#   2. Detached SSH signature (.sig) is valid against signing_key.pub
#
# SIGNING_IDENTITY must match the SIGNING_IDENTITY secret used in the
# GitHub Actions release workflow when the artifact was signed.
#
# SIGNING_NS is derived from the artifact filename prefix ({name}.release)
# and must match the SIGNING_NS env var in .github/workflows/release.yml.
#
# Requirements: ssh-keygen (OpenSSH 8.0+), sha256sum

set -euo pipefail

# ── Identity — must match the SIGNING_IDENTITY Actions secret ────────────────
SIGNING_IDENTITY="${SIGNING_IDENTITY:-david@worman.com}"

# ── Args ──────────────────────────────────────────────────────────────────────

if [ $# -ne 1 ]; then
    echo "Usage: $0 <artifact>"
    echo "Example: $0 myproject-1.0.tar.gz"
    exit 1
fi

ARTIFACT="$(realpath "$1")"
ARTIFACT_DIR="$(dirname "$ARTIFACT")"
ARTIFACT_NAME="$(basename "$ARTIFACT")"

if [ ! -f "$ARTIFACT" ]; then
    echo "ERROR: artifact not found: $ARTIFACT"
    exit 1
fi

# ── Derive signing namespace from artifact filename prefix ────────────────────
# Artifact is named {proj}-{version}.tar.gz → namespace is {proj}.release
PROJ_NAME="${ARTIFACT_NAME%%-*}"   # everything before the first hyphen
SIGNING_NS="${PROJ_NAME}.release"

# ── Locate supporting files ───────────────────────────────────────────────────

SIG_FILE="${ARTIFACT}.sig"
SHA_BASE="${ARTIFACT_NAME%.tar.gz}"
SHA_FILE="${ARTIFACT_DIR}/${SHA_BASE}.sha256"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${ARTIFACT_DIR}/signing_key.pub" ]; then
    PUB_KEY="${ARTIFACT_DIR}/signing_key.pub"
elif [ -f "${SCRIPT_DIR}/../signing_key.pub" ]; then
    PUB_KEY="$(realpath "${SCRIPT_DIR}/../signing_key.pub")"
else
    echo "ERROR: signing_key.pub not found."
    echo "Download it from the repository's main branch."
    exit 1
fi

if [ ! -f "$SIG_FILE" ]; then
    echo "ERROR: signature file not found: $SIG_FILE"
    echo "Download it alongside the artifact from the release page."
    exit 1
fi

echo "Verifying: $ARTIFACT_NAME"
echo "Namespace: $SIGNING_NS"
echo "Identity:  $SIGNING_IDENTITY"
echo ""

FAIL=0

# ── Step 1: SHA-256 checksum ─────────────────────────────────────────────────

echo "[ 1/2 ] Checksum..."
if [ -f "$SHA_FILE" ]; then
    EXPECTED=$(grep "$ARTIFACT_NAME" "$SHA_FILE" | awk '{print $1}')
    ACTUAL=$(sha256sum "$ARTIFACT" | awk '{print $1}')
    if [ "$EXPECTED" = "$ACTUAL" ]; then
        echo "        OK: $ACTUAL"
    else
        echo "        MISMATCH"
        echo "        expected: $EXPECTED"
        echo "        actual:   $ACTUAL"
        FAIL=1
    fi
else
    echo "        .sha256 not found — skipping"
fi

# ── Step 2: SSH signature ─────────────────────────────────────────────────────

echo "[ 2/2 ] SSH signature..."
ALLOWED=$(mktemp)
echo "$SIGNING_IDENTITY namespaces=\"$SIGNING_NS\" $(cat "$PUB_KEY")" > "$ALLOWED"

if ssh-keygen -Y verify \
    -f "$ALLOWED" \
    -I "$SIGNING_IDENTITY" \
    -n "$SIGNING_NS" \
    -s "$SIG_FILE" \
    < "$ARTIFACT" 2>/dev/null; then
    echo "        OK"
else
    echo "        INVALID"
    FAIL=1
fi
rm -f "$ALLOWED"

# ── Result ────────────────────────────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "VERIFIED: $ARTIFACT_NAME is authentic and unmodified."
    exit 0
else
    echo "FAILED: $ARTIFACT_NAME could not be verified."
    exit 1
fi
