#!/bin/bash
# enStudy 停止脚本：只停掉占用 8321 的服务，不启动新的
set -u
PORT=8321
PIDS=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  echo "🛑 已停止服务 (端口 $PORT): $PIDS"
else
  echo "ℹ️  端口 $PORT 没有运行中的服务"
fi
# 兜底：按进程名清理残留 node server.js
pkill -f "server.js" 2>/dev/null
