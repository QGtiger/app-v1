#!/bin/sh
set -e

echo "[sandbox] starting opencode serve..."
# CORS_ORIGIN 设定时透传给 opencode serve --cors（prod 放行 web 前端域名）；
# 未设定时走 opencode 默认行为（仅 localhost/127.0.0.1 放行，适用于本地 dev）。
if [ -n "$CORS_ORIGIN" ]; then
  exec opencode serve --hostname 0.0.0.0 --port 4096 --cors "$CORS_ORIGIN"
else
  exec opencode serve --hostname 0.0.0.0 --port 4096
fi
