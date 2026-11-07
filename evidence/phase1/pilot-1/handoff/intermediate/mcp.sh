#!/bin/bash
# sync /output/mcp -> /work/mcp (executable) and run fn-mcp against it
set -e
rm -rf /work/mcp
mkdir -p /work/mcp
cp -r /output/mcp/. /work/mcp/
chmod +x /work/mcp/launch.sh
export FN_GAME_PORT=${FN_GAME_PORT:-/work/port.sock}
exec node /opt/toolchain/fn/bin/fn-mcp.js "$@" -- /work/mcp/launch.sh
