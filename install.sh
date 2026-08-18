#!/bin/sh
# Mnemo one-liner installer and updater (FR-INSTALL-1, FR-INSTALL-4, FR-INSTALL-5).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- <target_dir>
#   sh install.sh .            # update the installation in the current directory
#   npm run update             # same, from inside an installation
#
# Re-running on an existing installation updates it instead of failing. An update
# refreshes the source only: <target>/data/ (notes, assets, config.json, jobs) is
# never written, moved, or deleted by this script (FR-INSTALL-4, NFR-1b).
set -eu

REPO_URL="${MNEMO_REPO_URL:-https://github.com/aquaxis/mnemo.git}"
TARBALL_URL="${MNEMO_TARBALL_URL:-https://github.com/aquaxis/mnemo/archive/refs/heads/main.tar.gz}"
TARGET_DIR="${1:-mnemo}"

# Paths refreshed by an update — everything the repository ships.
# `data/` and `node_modules/` are deliberately absent: user content is never
# part of an update (NFR-1b).
SOURCE_PATHS="server web templates install.sh package.json package-lock.json \
tsconfig.base.json eslint.config.js .prettierrc.json .gitignore \
README.md README_ja.md LICENSE"

die() {
  echo "Error: $*" >&2
  exit 1
}

require_node() {
  command -v node >/dev/null 2>&1 ||
    die "Node.js (>=18) is required. Install it from https://nodejs.org/"
}

# A Mnemo installation is a directory whose package.json declares name "mnemo".
is_mnemo_install() {
  [ -f "$1/package.json" ] &&
    grep -q '"name"[[:space:]]*:[[:space:]]*"mnemo"' "$1/package.json"
}

dir_is_empty() {
  [ -e "$1" ] || return 0
  [ -d "$1" ] || return 1
  [ -z "$(ls -A "$1" 2>/dev/null)" ]
}

# install | update | abort
detect_mode() {
  if dir_is_empty "$1"; then
    echo install
  elif is_mnemo_install "$1"; then
    echo update
  else
    echo abort
  fi
}

# Extract the source tarball into an existing directory.
fetch_tarball_into() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download the source."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the source."
  curl -fsSL "$TARBALL_URL" | tar -xz --strip-components=1 -C "$1"
}

do_install() {
  echo "Installing Mnemo into ${TARGET_DIR} ..."
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
  else
    mkdir -p "$TARGET_DIR"
    fetch_tarball_into "$TARGET_DIR"
  fi
}

# Git checkout: fast-forward only. A dirty tree or a diverged branch aborts with
# an explanation — the source is never force-reset, and data/ is untouched either
# way (it is git-ignored).
update_from_git() {
  echo "Updating the source (git) ..."
  # Only *tracked* modifications can block a fast-forward. Untracked files —
  # notes an agent wrote, editor leftovers, a stray script — never do, so they
  # must not stop an update.
  if [ -n "$(git -C "$TARGET_DIR" status --porcelain --untracked-files=no)" ]; then
    die "the installation has local changes to tracked files. Commit, stash, or revert them and re-run.
       Nothing was modified; your data/ directory is untouched."
  fi
  branch=$(git -C "$TARGET_DIR" rev-parse --abbrev-ref HEAD)
  echo "  git pull --ff-only (branch: ${branch})"
  git -C "$TARGET_DIR" pull --ff-only ||
    die "the update is not a fast-forward (the local branch has diverged).
       Reconcile it manually and re-run. Nothing was modified; your data/ is untouched."
}

# No git: download to a temporary directory, then copy the source paths over the
# installation. data/ and node_modules/ are never part of the copy, so user
# content cannot be clobbered; a failed download leaves the install as it was.
update_from_tarball() {
  echo "Updating the source (tarball) ..."
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/mnemo-update.XXXXXX") ||
    die "cannot create a temporary directory."
  trap 'rm -rf "$tmp"' EXIT INT TERM
  fetch_tarball_into "$tmp"
  is_mnemo_install "$tmp" ||
    die "the downloaded archive does not look like Mnemo; the installation was not modified."
  for path in $SOURCE_PATHS; do
    [ -e "$tmp/$path" ] || continue
    if [ -d "$tmp/$path" ]; then
      mkdir -p "$TARGET_DIR/$path"
      cp -R "$tmp/$path/." "$TARGET_DIR/$path/"
    else
      cp -f "$tmp/$path" "$TARGET_DIR/$path"
    fi
  done
  rm -rf "$tmp"
  trap - EXIT INT TERM
}

do_update() {
  echo "Updating the Mnemo installation in ${TARGET_DIR} ..."
  echo "Your data/ directory (notes, assets, config.json, jobs) is preserved."
  if [ -d "$TARGET_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    update_from_git
  else
    update_from_tarball
  fi
}

build() {
  (cd "$TARGET_DIR" && npm install && npm run build)
}

# --- Main -------------------------------------------------------------------
require_node

MODE=$(detect_mode "$TARGET_DIR")
case "$MODE" in
  install) do_install ;;
  update) do_update ;;
  *)
    die "${TARGET_DIR} exists and is not a Mnemo installation.
       Refusing to overwrite it. Pass another directory name, e.g.
         sh install.sh my-mnemo"
    ;;
esac

build

echo ""
if [ "$MODE" = update ]; then
  echo "Mnemo updated. Restart it with:"
else
  echo "Mnemo installed. Start it with:"
fi
if [ "$TARGET_DIR" = "." ]; then
  echo "  npm start"
else
  echo "  cd ${TARGET_DIR} && npm start"
fi
echo "Then open http://localhost:3000"
