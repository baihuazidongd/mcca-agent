@echo off
rem One-click launcher: install once, then start the portal.
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [start] pnpm not found. Install it with: npm install -g pnpm
  exit /b 1
)

if not exist node_modules (
  echo [start] installing dependencies ^(first run only^)...
  call pnpm install || exit /b 1
)

if not exist config\mcp.json (
  echo [start] building and preparing configuration ^(first run only^)...
  call pnpm run setup || exit /b 1
)

node scripts\start.mjs
