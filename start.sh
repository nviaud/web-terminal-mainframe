#!/bin/bash

# start.sh for web3270

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SERVER_PATH="$SCRIPT_DIR/dist/server.js"
PORT=${PORT:-3000}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
	echo "[ERROR] Node.js is not installed." >&2
	exit 1
fi

# Check if c3270 is installed (required to spawn terminal sessions)
if ! command -v c3270 &> /dev/null; then
	echo "[ERROR] c3270 is not installed. Please install c3270 to run the server." >&2
	exit 1
fi

# Check if server file exists
if [ ! -f "$SERVER_PATH" ]; then
	echo "[ERROR] Server file $SERVER_PATH not found. Run 'npm run build' first." >&2
	exit 1
fi

echo "[INFO] Starting web3270 server on port $PORT..."
[ -n "$DEFAULT_SERVER" ] && echo "[INFO] Default server: $DEFAULT_SERVER"

exec env PORT="$PORT" node "$SERVER_PATH"
