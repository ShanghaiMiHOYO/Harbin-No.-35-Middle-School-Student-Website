@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

echo [%date% %time%] start server >> "data\server.log"
"%NODE%" server.js >> "data\server.log" 2>&1
