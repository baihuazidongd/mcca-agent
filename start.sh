#!/usr/bin/env sh
# One-click launcher: install once, then start the portal.
set -e
cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[start] pnpm not found. Install it with: npm install -g pnpm"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[start] installing dependencies (first run only)..."
  pnpm install
fi

if [ ! -f config/mcp.json ]; then
  echo "[start] building and preparing configuration (first run only)..."
  pnpm run setup
fi

exec node scripts/start.mjs
