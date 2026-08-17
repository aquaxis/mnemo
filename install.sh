#!/bin/sh
# Mnemo one-liner installer (FR-INSTALL-1).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- <target_dir>
set -eu

REPO_URL="${MNEMO_REPO_URL:-https://github.com/aquaxis/mnemo.git}"
TARGET_DIR="${1:-mnemo}"

echo "Installing Mnemo into ./${TARGET_DIR} ..."

# --- Require Node.js (no Python allowed anywhere; C-2) ----------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>=18) is required. Install it from https://nodejs.org/" >&2
  exit 1
fi

# --- Fetch the source (git preferred, tarball fallback) --------------------
if command -v git >/dev/null 2>&1; then
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
else
  mkdir -p "$TARGET_DIR"
  TARBALL="${MNEMO_TARBALL_URL:-https://github.com/aquaxis/mnemo/archive/refs/heads/main.tar.gz}"
  curl -fsSL "$TARBALL" | tar -xz --strip-components=1 -C "$TARGET_DIR"
fi

cd "$TARGET_DIR"

# --- Install dependencies and build ----------------------------------------
npm install
npm run build

echo ""
echo "Mnemo installed. Start it with:"
echo "  cd ${TARGET_DIR} && npm start"
echo "Then open http://localhost:3000"
