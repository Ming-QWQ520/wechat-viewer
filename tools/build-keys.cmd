@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where go >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 Go，请先安装 Go 1.21+：https://go.dev/dl/
  pause
  exit /b 1
)

pushd keyextract-src
go build -o ..\wechat-keys.exe .
if errorlevel 1 (
  popd
  echo [x] 编译失败
  pause
  exit /b 1
)
popd

echo [+] 已生成 tools\wechat-keys.exe
