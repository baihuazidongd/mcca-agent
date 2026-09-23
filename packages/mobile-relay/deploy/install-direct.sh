#!/usr/bin/env bash
# mcca-relay 直连部署（在自己的公网服务器上以 root 运行，relay 直接听 80）
#
#   bash install-direct.sh <token>
#
# 做的事：/opt/node 装 Node 22 → /opt/mcca-relay 放 server.cjs + ws 依赖 +
# config.json(token) → systemd mcca-relay 监听 0.0.0.0:80。
# App 侧地址填 <公网IP>（无 /mcca 前缀），桌面 relayUrl 用 ws://<公网IP>/desktop
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.11.0}"
RELAY_DIR=/opt/mcca-relay
NODE_DIR=/opt/node
TOKEN="${1:-}"
PORT="${RELAY_PORT:-80}"

if [ -z "$TOKEN" ]; then
  echo "usage: bash install-direct.sh <token>" >&2
  exit 1
fi

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "==> installing Node.js $NODE_VERSION"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
export PATH="$NODE_DIR/bin:$PATH"
node --version

echo "==> writing $RELAY_DIR"
mkdir -p "$RELAY_DIR"
cd "$RELAY_DIR"
[ -f server.cjs ] || { echo "server.cjs 没上传" >&2; exit 1; }
cat > package.json <<'JSON'
{ "name": "mcca-relay", "private": true, "version": "0.1.0", "dependencies": { "ws": "^8.18.0" } }
JSON
[ -d node_modules/ws ] || npm install --omit=dev --no-audit --no-fund
node -e "require('ws'); console.log('ws ok')"

cat > config.json <<JSON
{ "token": "$TOKEN" }
JSON
chmod 600 config.json

echo "==> systemd"
cat > /etc/systemd/system/mcca-relay.service <<UNIT
[Unit]
Description=mcca mobile relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$RELAY_DIR
Environment=RELAY_CONFIG=$RELAY_DIR/config.json
Environment=RELAY_PORT=$PORT
Environment=RELAY_HOST=0.0.0.0
Environment=RELAY_APK=$RELAY_DIR/app.apk
Environment=RELAY_VERSION=$RELAY_DIR/version.json
ExecStart=$NODE_DIR/bin/node $RELAY_DIR/server.cjs
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable mcca-relay >/dev/null 2>&1 || true
systemctl restart mcca-relay
sleep 1
systemctl --no-pager --lines=6 status mcca-relay || true

echo "==> health"
curl -fsS "http://127.0.0.1:$PORT/health" || true
echo
echo "done. App 填 http://<公网IP>，桌面 relayUrl=ws://<公网IP>/desktop"
