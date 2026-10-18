@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

echo [%date% %time%] start tunnel >> "data\tunnel.log"
"%NODE%" scripts\tunnel.js >> "data\tunnel.log" 2>&1
