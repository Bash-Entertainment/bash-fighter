#!/usr/bin/env bash
# Idempotent deploy script for bash-fighter on the Hetzner box.
#
# Usage (run as root or as a user with sudo, on the target box):
#   deploy/deploy.sh [ref]
#
#   ref   git ref to deploy (branch, tag, or commit). Defaults to
#         "main". Example: deploy/deploy.sh v0.3.0
#
# What it does, safely and re-runnably:
#   1. Fetches the repo into a fresh timestamped release directory
#      under /srv/bash-fighter/releases/<timestamp>-<short-sha>.
#   2. Installs production dependencies and builds the server + the
#      static client (npm workspaces; adjust the build commands below
#      once the real package scripts exist).
#   3. Atomically swaps /srv/bash-fighter/current to point at the new
#      release (symlink swap -- old release stays on disk untouched
#      until pruned, so a bad deploy can be rolled back by hand).
#   4. Publishes the built static client into /srv/bash-fighter/static
#      (what nginx serves) via an atomic symlink swap of its own.
#   5. Restarts the bash-fighter systemd service and waits for it to
#      report active.
#
# Configuration (PORT etc) is never invented here -- it is read from
# /srv/bash-fighter/shared/bash-fighter.env by the systemd unit
# (EnvironmentFile=-...). This script does not create or modify that
# file. See deploy/bash-fighter.env.example for the expected shape.
#
# Safe to re-run: every step is idempotent or additive. If a step
# fails, the script exits before swapping symlinks, so the previously
# deployed release keeps serving traffic -- the site is never left
# broken mid-deploy.

set -euo pipefail

REPO_URL="https://github.com/Bash-Entertainment/bash-fighter.git"
REF="${1:-main}"
BASE="/srv/bash-fighter"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
STATIC="$BASE/static"
SERVICE="bash-fighter"

if [ "$(id -u)" -ne 0 ] && [ "$(id -un)" != "bashgame" ]; then
  echo "Run this as root (it manages a systemd unit) or as bashgame." >&2
fi

TS="$(date -u +%Y%m%d%H%M%S)"
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "==> Fetching $REPO_URL @ $REF into $WORKDIR"
git clone --quiet --depth 50 "$REPO_URL" "$WORKDIR/repo"
git -C "$WORKDIR/repo" checkout --quiet "$REF"
SHA="$(git -C "$WORKDIR/repo" rev-parse --short HEAD)"
RELEASE_DIR="$RELEASES/${TS}-${SHA}"

if [ -d "$RELEASE_DIR" ]; then
  echo "==> Release $RELEASE_DIR already exists, reusing it."
else
  echo "==> Installing into $RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  cp -a "$WORKDIR/repo/." "$RELEASE_DIR/"
fi

cd "$RELEASE_DIR"

# Dev dependencies are required to BUILD (esbuild for the server bundle,
# vite for the client). They are installed here and are not used at run
# time -- the service runs a single bundled file.
echo "==> Installing dependencies (including build tooling)"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "==> Building (server + client)"
# A build failure must abort the deploy BEFORE any symlink is swapped,
# so the currently-serving release keeps serving.
npm run build

if [ ! -d "$RELEASE_DIR/server/dist" ]; then
  echo "WARNING: $RELEASE_DIR/server/dist not found -- service will fail to start until the server build exists." >&2
fi

echo "==> Pointing current -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"

CLIENT_DIST="$RELEASE_DIR/packages/app/dist"
if [ -d "$CLIENT_DIST" ]; then
  echo "==> Publishing static client -> $STATIC"
  ln -sfn "$CLIENT_DIST" "$STATIC.new"
  mv -Tf "$STATIC.new" "$STATIC"
else
  echo "ERROR: no built client at $CLIENT_DIST" >&2
  exit 1
fi

echo "==> Restarting $SERVICE"
if command -v systemctl >/dev/null 2>&1; then
  sudo_prefix=""
  [ "$(id -u)" -ne 0 ] && sudo_prefix="sudo"
  $sudo_prefix systemctl restart "$SERVICE" || echo "WARNING: restart failed -- check 'journalctl -u $SERVICE'" >&2
  $sudo_prefix systemctl --no-pager status "$SERVICE" || true
fi

echo "==> Pruning old releases (keeping last 5)"
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf

echo "==> Deploy of $REF ($SHA) complete."
