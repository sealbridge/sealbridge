#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

app_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

if [ "$#" -eq 0 ] || [ "$1" = "mcp-server" ]; then
  if [ "$#" -gt 0 ]; then shift; fi
  key_path=${SEALBRIDGE_KEY_PATH:-/data/owner.private.json}
  if [ -n "${SEALBRIDGE_RELAY_URL:-}" ]; then
    set -- --relay "$SEALBRIDGE_RELAY_URL" "$@"
  fi
  node "$app_dir/scripts/docker-runtime-identity.mjs" "$key_path"
  exec node "$app_dir/cli/dist/index.js" mcp-server --key "$key_path" "$@"
fi

exec "$@"
