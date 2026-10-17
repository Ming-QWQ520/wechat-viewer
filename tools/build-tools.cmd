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

echo [1/2] 编译密钥提取器...
pushd keyextract-src
go build -o ..\wechat-keys.exe .
if errorlevel 1 (
  popd
  echo [x] 密钥提取器编译失败
  pause
  exit /b 1
)
popd

echo [2/2] 编译图片完整性校验器...
pushd imgcheck-src
go build -o ..\imgcheck.exe .
if errorlevel 1 (
  popd
  echo [x] 图片校验器编译失败
  pause
  exit /b 1
)
popd

echo [+] 已生成 tools\wechat-keys.exe 与 tools\imgcheck.exe
