@echo off
setlocal EnableExtensions
chcp 65001 >nul
title GReview Launcher
cd /d "%~dp0"

echo ==========================================
echo   GReview - 本地 Steam 评论分析工具
echo ==========================================
echo.

set "CHECK_ONLY=0"
set "NO_BROWSER=0"
if /i "%~1"=="--check" set "CHECK_ONLY=1"
if /i "%~1"=="--no-browser" set "NO_BROWSER=1"

where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
node -e "const m=process.versions.node.split('.').map(Number);process.exit(m[0]>=20?0:1)"
if errorlevel 1 goto old_node

where npm >nul 2>nul
if errorlevel 1 goto no_npm

echo [1/3] Node.js %NODE_VERSION% / npm 已就绪

if "%CHECK_ONLY%"=="1" (
  echo CHECK_OK
  exit /b 0
)

if not exist "node_modules" (
  echo [2/3] 首次运行，正在安装依赖（可能需要 1-2 分钟）...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo npm ci 失败，改用 npm install 重试...
    call npm install --no-audit --no-fund
    if errorlevel 1 goto install_failed
  )
) else (
  echo [2/3] 依赖已安装
)

if not exist "server\dist\index.js" goto build
if not exist "web\dist\index.html" goto build
goto check_running

:build
echo [2/3] 正在构建前端与后端...
call npm run build
if errorlevel 1 goto build_failed

:check_running
node -e "fetch('http://127.0.0.1:53821/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 goto already_running

echo [3/3] 正在启动 GReview...
if "%NO_BROWSER%"=="0" start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:53821'"
call npm start
if errorlevel 1 goto start_failed
exit /b 0

:already_running
echo [3/3] GReview 已在运行，正在打开浏览器...
if "%NO_BROWSER%"=="0" start "" "http://127.0.0.1:53821"
exit /b 0

:no_node
echo [错误] 未检测到 Node.js。
echo GReview 需要 Node.js 20 或更高版本。
echo 即将打开下载页面；安装后请重新双击本文件。
start "" "https://nodejs.org/zh-cn/download"
pause
exit /b 1

:old_node
echo [错误] 当前 Node.js 版本为 %NODE_VERSION%，低于 20。
echo 请安装 Node.js 20 或更高版本后重试。
start "" "https://nodejs.org/zh-cn/download"
pause
exit /b 1

:no_npm
echo [错误] 未检测到 npm。请重新安装 Node.js（安装包会包含 npm）。
pause
exit /b 1

:install_failed
echo [错误] 依赖安装失败。请检查网络，或在命令行执行 npm install 查看详情。
pause
exit /b 1

:build_failed
echo [错误] 构建失败。请检查上方错误信息。
pause
exit /b 1

:start_failed
echo [错误] GReview 启动失败。若端口 53821 被占用，请关闭占用程序后重试。
pause
exit /b 1
