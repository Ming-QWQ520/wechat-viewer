@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   WeChatViewer - 微信聊天记录查看器
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

set "NEED_KEYS=0"
if not exist "data\keys.json" set "NEED_KEYS=1"
if "%NEED_KEYS%"=="0" (
  node -e "try{const k=require('./data/keys.json');process.exit(k.emoticon_aes_key&&k.account_seed?0:1)}catch(e){process.exit(1)}"
  if errorlevel 1 set "NEED_KEYS=1"
)

if "%NEED_KEYS%"=="1" (
  echo [1/2] 正在从运行中的微信进程提取数据库密钥与账户 seed...
  "tools\wechat-keys.exe" -out "data\keys.json"
  if errorlevel 1 (
    echo.
    echo [x] 密钥提取失败。请确认：
    echo     - 微信已启动并已登录
    echo     - 以当前用户运行（如失败可尝试以管理员身份运行）
    pause
    exit /b 1
  )
) else (
  echo [1/2] 使用已有的 data\keys.json（如需重新提取请先删除该文件）
)

echo [2/2] 启动查看器（首次启动会解密数据库，约 10-30 秒）...
echo.
node "app\server.mjs"
echo.
echo 查看器已退出。
pause
