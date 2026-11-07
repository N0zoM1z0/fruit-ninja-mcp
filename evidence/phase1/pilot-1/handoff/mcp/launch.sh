#!/bin/sh
# Launch the Fruit Ninja Dojo MCP server on stdio.
# Paths are resolved relative to this script so the bundle works from /opt/mcp.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/server.js"
