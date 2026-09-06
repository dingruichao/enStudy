#!/bin/bash
# enStudy 启动脚本（幂等：若端口已占用则提示，不重复启动）
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/dingrc/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
export NODE_PATH="/Users/dingrc/.workbuddy/binaries/node/workspace/node_modules"
PORT=8321
HOST=0.0.0.0

# 已在本端口监听则直接提示退出
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已有服务在运行，无需重复启动。"
  echo "    如需重启请运行: ./restart.sh"
  exit 0
fi

cd "$ROOT" || exit 1
nohup "$NODE" server.js > server.log 2>&1 &
PID=$!
echo "🚀 已后台启动 enStudy (PID $PID)"
sleep 1.5
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ 启动成功: http://127.0.0.1:$PORT"
  LAN=$(ipconfig getifaddr en0 2>/dev/null || true)
  [ -n "$LAN" ] && echo "   手机访问: http://$LAN:$PORT"
else
  echo "❌ 启动似乎失败，请查看 server.log："
  tail -n 20 server.log 2>/dev/null
fi
