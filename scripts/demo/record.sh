#!/usr/bin/env bash
# Seeds a throwaway SIL home and serves the web console on it for the demo recording.
set -euo pipefail
cd "$(dirname "$0")/../.."

home="${SIL_DEMO_HOME:-/tmp/sil-demo-home}"
rm -rf "$home"
mkdir -p "$home"/{config,state,data,claude}
export SIL_CONFIG_DIR="$home/config" SIL_STATE_DIR="$home/state" SIL_DATA_DIR="$home/data"
export CLAUDE_CONFIG_DIR="$home/claude" GIT_CONFIG_GLOBAL="$home/gitconfig" GIT_CONFIG_SYSTEM="$home/gitconfig"
unset CLAUDE_PLUGIN_ROOT
git config --file "$home/gitconfig" user.name demo
git config --file "$home/gitconfig" user.email demo@example.com

bun run sil init >/dev/null
bun scripts/demo/seed.ts
exec bun run sil web --port "${SIL_DEMO_PORT:-8799}" --no-token --no-watch
