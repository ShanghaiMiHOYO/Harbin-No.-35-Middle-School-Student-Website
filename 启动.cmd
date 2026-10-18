@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

echo.
echo   三十五中学生网（本地版）
echo   本机访问   http://127.0.0.1:8787
echo   局域网     见网站「关于」页里的「局域网地址」
echo   管理员密码 cphrqrdc
echo   关闭这个窗口即可停止服务
echo.
"%NODE%" server.js
echo.
echo 服务已退出，按任意键关闭窗口。
pause >nul
