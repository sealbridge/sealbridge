#!/bin/sh
set -eu
# Dedicated user-local installation; never changes system Node or user keys.
ROOT="$HOME/.local/share/sealbridge"
NODE_VERSION=22.22.0
PACKAGE=sealbridge@0.2.2
NODE_EXECUTABLE=missing
NODE_ACTUAL_VERSION=unknown
NPM_STATE="not checked"
fail() { printf 'Sealbridge: %s\n' "$*" >&2; exit 1; }
check_node() {
  # Unix npm launchers use the node found on PATH via /usr/bin/env.
  NODE_EXECUTABLE=$(command -v node) || { NODE_EXECUTABLE=missing; return 1; }
  NODE_ACTUAL_VERSION=$("$NODE_EXECUTABLE" -p process.versions.node) || return 1
  NODE_EXECUTABLE=$("$NODE_EXECUTABLE" -p process.execPath) || return 1
  printf '%s\n' "$NODE_ACTUAL_VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || return 1
  NODE_MAJOR=${NODE_ACTUAL_VERSION%%.*}
  case "$NODE_MAJOR" in ''|*[!0-9]*) return 1;; esac
  [ "$NODE_MAJOR" -ge 22 ]
}
check_runtime() {
  NPM_STATE='not checked (Node missing, failed, or older than 22)'
  check_node || return 1
  # A co-installed npm is the npm-cli.js targeted by the launcher beside the
  # resolved Node. Accept symlinks (including distro layouts), not an unrelated
  # npm elsewhere on PATH. Run that entry point with this exact Node, bypassing
  # launcher shebangs/wrappers that might select a different runtime.
  NPM_LAUNCHER="$(dirname "$NODE_EXECUTABLE")/npm"
  NPM_STATE="missing or unrecognized npm beside $NODE_EXECUTABLE"
  [ -f "$NPM_LAUNCHER" ] || return 1
  NPM_CLI=$("$NODE_EXECUTABLE" -p 'require("fs").realpathSync(process.argv[1])' "$NPM_LAUNCHER" 2>/dev/null) || return 1
  case "$NPM_CLI" in */npm/bin/npm-cli.js) ;; *) return 1;; esac
  NPM_STATE="npm failed: $NPM_CLI"
  NPM_VERSION=$("$NODE_EXECUTABLE" "$NPM_CLI" --version 2>/dev/null) || return 1
  NPM_STATE="npm returned an invalid version: $NPM_CLI"
  case "$NPM_VERSION" in *'
'*) return 1;; esac
  printf '%s\n' "$NPM_VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || return 1
  NPM_STATE="$NPM_CLI ($NPM_VERSION)"
}
runtime_error() {
  printf 'Runtime found: node %s (%s); npm: %s.\n' "$NODE_EXECUTABLE" "$NODE_ACTUAL_VERSION" "$NPM_STATE" >&2
  printf 'Install Node 22 or newer with its bundled npm, put that installation first on PATH, and rerun. For automatic installation, check internet access to nodejs.org and write access to %s.\n' "$ROOT" >&2
}

case "${1:-}" in
  --uninstall)
    if [ -f "$ROOT/.installer-owned" ]; then
      rm -rf "$ROOT"
      printf 'Removed Sealbridge. Keys are preserved. Remove the # sealbridge installer lines from your shell profiles.\n'
    else fail 'No installer-owned installation found; nothing removed.'; fi
    exit 0;;
  '') ;;
  *) fail 'Usage: sh install.sh [--uninstall]';;
esac
trap 'runtime_error' 0
[ ! -d "$ROOT" ] || [ -f "$ROOT/.installer-owned" ] || fail "Installation directory already exists without an ownership marker: $ROOT"
mkdir -p "$ROOT"
: > "$ROOT/.installer-owned"
PATH="$ROOT/node/bin:$ROOT/npm/bin:$PATH"
export PATH
if ! check_runtime; then
  printf 'Runtime found: node %s (%s); npm: %s.\n' "$NODE_EXECUTABLE" "$NODE_ACTUAL_VERSION" "$NPM_STATE"
  printf 'Installing user-local Node %s with bundled npm.\n' "$NODE_VERSION"
  case "$(uname -s)" in Linux) OS=linux;; Darwin) OS=darwin;; *) fail 'Supported systems: Linux and macOS.';; esac
  case "$(uname -m)" in x86_64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) fail 'Supported architectures: x64 and arm64.';; esac
  command -v curl >/dev/null 2>&1 || fail 'Install curl first.'
  FILE="node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  TMP=$(mktemp -d "$ROOT/download.XXXXXX")
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$FILE" -o "$TMP/$FILE"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECTED=$(awk -v file="$FILE" '$2 == file {print $1}' "$TMP/SHASUMS256.txt")
  [ "${#EXPECTED}" -eq 64 ] || fail 'Official checksum is missing.'
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$FILE" | awk '{print $1}');
  else ACTUAL=$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}'); fi
  [ "$EXPECTED" = "$ACTUAL" ] || fail 'Node checksum mismatch; installation stopped.'
  mkdir -p "$ROOT/node"
  tar -xzf "$TMP/$FILE" -C "$ROOT/node" --strip-components=1
  rm -rf "$TMP"
  hash -r
  DOWNLOADED_NODE=$("$ROOT/node/bin/node" -p process.execPath) || fail 'Downloaded Node is not runnable.'
  check_runtime || fail 'Downloaded Node or its bundled npm is not usable.'
  [ "$NODE_EXECUTABLE" = "$DOWNLOADED_NODE" ] || fail 'Downloaded Node was not selected.'
fi
# npm and the installed Unix CLI shims must resolve the selected Node on PATH.
PATH="$(dirname "$NODE_EXECUTABLE"):$PATH"
export PATH
# Explicit local tarball override for release CI; never defaults to an unpublished package.
if [ -n "${SEALBRIDGE_INSTALL_TARBALL:-}" ]; then
  [ -f "$SEALBRIDGE_INSTALL_TARBALL" ] || fail 'Local test tarball does not exist.'
  PACKAGE=$SEALBRIDGE_INSTALL_TARBALL
fi
"$NODE_EXECUTABLE" "$NPM_CLI" install --global --prefix "$ROOT/npm" --ignore-scripts --no-audit --no-fund "$PACKAGE"
check_runtime || fail 'The selected Node and npm are no longer usable.'
printf 'Node.js: %s (%s)\n' "$NODE_ACTUAL_VERSION" "$NODE_EXECUTABLE"
LINE='export PATH="$HOME/.local/share/sealbridge/node/bin:$HOME/.local/share/sealbridge/npm/bin:$PATH" # sealbridge installer'
for PROFILE in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if ! grep -Fq '# sealbridge installer' "$PROFILE" 2>/dev/null; then printf '\n%s\n' "$LINE" >> "$PROFILE"; fi
done
sealbridge --version
if ! sealbridge doctor; then printf 'Installed, but doctor found an issue. Follow its fixes and rerun sealbridge doctor.\n'; fi
trap - 0
printf 'Installed. Open a new terminal, or run: . "$HOME/.profile"\nThen run: sealbridge demo\nUninstall: sh install.sh --uninstall\n'
