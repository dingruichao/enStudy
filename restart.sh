#!/bin/bash
# enStudy 重启脚本：先停掉占用 8321 的旧进程，再启动新实例
set -u
PORT=8321
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🛑 停止旧服务 (端口 $PORT)..."
PIDS=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  echo "   已发送停止信号给: $PIDS"
fi
# 兜底：按进程名清理残留 node server.js
pkill -f "server.js" 2>/dev/null
sleep 1

echo "♻️  启动新服务..."
exec "$SCRIPT_DIR/start.sh"
