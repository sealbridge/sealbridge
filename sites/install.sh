#!/bin/sh
set -eu
# Dedicated user-local installation; never changes system Node or user keys.
ROOT="$HOME/.local/share/sealbridge"
NODE_VERSION=22.22.0
CLI=${SEALBRIDGE_INSTALL_PACKAGE:-sealbridge}
NO_ACCEPT=false
UNINSTALL=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) [ "$#" -ge 2 ] || { printf 'Missing --package value\n' >&2; exit 1; }; CLI=$2; shift 2;;
    --no-accept) NO_ACCEPT=true; shift;;
    --uninstall) UNINSTALL=true; shift;;
    *) printf 'Usage: sh install.sh [--package sealbridge|sealbridge-local] [--no-accept] [--uninstall]\n' >&2; exit 1;;
  esac
done
case "$CLI" in sealbridge|sealbridge-local) ;; *) printf "Choose sealbridge or sealbridge-local\n" >&2; exit 1;; esac
PACKAGE=$CLI@0.10.1
# Both distributions pin the prepared 0.10.1 release (publish before deployment).
[ "$CLI" != sealbridge-local ] || PACKAGE=sealbridge-local@0.10.1
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

case "$UNINSTALL" in
  true)
    if [ -f "$ROOT/.installer-owned" ]; then
      rm -rf "$ROOT"
      printf 'Removed Sealbridge. Keys are preserved. Remove the # sealbridge installer lines from your shell profiles.\n'
    else fail 'No installer-owned installation found; nothing removed.'; fi
    exit 0;;
esac
trap 'runtime_error' 0
[ ! -d "$ROOT" ] || [ -f "$ROOT/.installer-owned" ] || fail "Installation directory already exists without an ownership marker: $ROOT"
mkdir -p "$ROOT"
# On Linux this is also the default application data root. Settings and keys
# require an owner-only directory, including after upgrading an older install.
chmod 700 "$ROOT"
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
if ! "$NODE_EXECUTABLE" "$NPM_CLI" install --global --prefix "$ROOT/npm" --ignore-scripts --no-audit --no-fund "$PACKAGE"; then
  [ "$CLI" != sealbridge-local ] || printf 'Failed to fetch sealbridge-local 0.10.1 from npm. Check npm availability and retry.\n' >&2
  fail "npm installation failed for $CLI."
fi
check_runtime || fail 'The selected Node and npm are no longer usable.'
printf 'Node.js: %s (%s)\n' "$NODE_ACTUAL_VERSION" "$NODE_EXECUTABLE"
LINE='export PATH="$HOME/.local/share/sealbridge/node/bin:$HOME/.local/share/sealbridge/npm/bin:$PATH" # sealbridge installer'
for PROFILE in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if ! grep -Fq '# sealbridge installer' "$PROFILE" 2>/dev/null; then printf '\n%s\n' "$LINE" >> "$PROFILE"; fi
done
"$CLI" --version
if ! "$CLI" doctor; then printf 'Installed, but doctor found an issue. Follow its fixes and rerun sealbridge doctor.\n'; fi
trap - 0
printf 'Installed. Open a new terminal, or run: . "$HOME/.profile"\nThen run: %s demo\nUninstall: sh install.sh --uninstall\n' "$CLI"

# Isolate descriptors, signal handlers and secret variables from the installer.
# Do not collect a secret under tracing, or if printf might be an external process.
accept_invite() (
  [ "$NO_ACCEPT" = false ] || exit 0
  [ -z "${CI:-}${CONTINUOUS_INTEGRATION:-}${GITHUB_ACTIONS:-}${TF_BUILD:-}${BUILD_ID:-}${JENKINS_URL:-}" ] || exit 0
  case "$-" in *x*|*v*|*a*) exit 0;; esac
  [ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 0
  case "$(LC_ALL=C command -V printf 2>/dev/null)" in *builtin*) ;; *) exit 0;; esac
  # Open in a nested subshell first: a failed special-builtin redirection must
  # not terminate the successful installation, or emit an unsafe diagnostic.
  ( : <> /dev/tty ) 2>/dev/null || exit 0
  exec 3<> /dev/tty
  tty_state=$(stty -g <&3 2>/dev/null) || exit 0
  restore_tty() { stty "$tty_state" <&3 2>/dev/null || :; }
  trap 'restore_tty' 0
  trap 'exit 0' 1 2 15
  printf '\nOptional invitation import.\n' >&3
  stty -echo <&3 2>/dev/null || exit 0
  printf 'Paste an invitation (hidden), or press Enter to skip: ' >&3
  unset invite
  invite=
  if ! IFS= read -r invite <&3; then
    restore_tty
    printf '\nTo import later, run: %s accept --paste\n' "$CLI" >&3
    exit 0
  fi
  printf '\n' >&3
  [ -n "$invite" ] || exit 0
  # One conservative gate for every input form, including unknown strings:
  # normalization or a future CLI recognition change cannot bypass consent.
  printf 'A normal invitation token imports only and creates no connection.\nA short link contacts the relay, consumes the link, connects immediately\nto the inviter and sends a connection request. It signs connection consent;\nit does not approve work. Continue? Type y to accept [y/N]: ' >&3
  unset answer
  answer=
  IFS= read -r answer <&3 || exit 0
  restore_tty
  printf '\n' >&3
  [ "$answer" = y ] || exit 0
  unset answer
  # printf is a shell builtin (checked above); the secret never enters argv.
  # Discard CLI output, including peer-controlled metadata and failure text.
  if printf '%s\n' "$invite" | "$CLI" accept --stdin 3<&- >/dev/null 2>&1; then
    printf 'Invitation imported. Run %s invites list to see saved names.\n' "$CLI" >&3
  else
    printf 'To import later, run: %s accept --paste\n' "$CLI" >&3
  fi
  unset invite
  exit 0
)
accept_invite || :
