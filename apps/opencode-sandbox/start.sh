#!/bin/sh
set -e

echo "[sandbox] starting opencode serve..."
exec opencode serve --hostname 0.0.0.0 --port 4096
