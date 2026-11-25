@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 Node.js，请先安装 Node.js 18 或更高版本: https://nodejs.org/
  pause
  exit /b 1
)

echo [1/2] 安装依赖（首次约需几分钟，会下载 Electron）...
call npm install
if errorlevel 1 goto fail

echo [2/2] 打包免安装版 exe...
call npm run dist:exe
if errorlevel 1 goto fail

echo.
echo [OK] 打包完成: %cd%\release
start "" "%cd%\release"
pause
exit /b 0

:fail
echo.
echo [x] 打包失败，请把上面的输出发给我。
echo     如果卡在下载 Electron，可先设置镜像后重试:
echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo     set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pause
exit /b 1
