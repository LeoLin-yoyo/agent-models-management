@echo off
rem agent-models-management silent autostart (invoked hidden by ammp_silent.vbs at logon).
rem guard: exit if ammp already running on 3210
netstat -ano | findstr /C:":3210 " | findstr /C:"LISTENING" >nul && exit /b 0
cd /d %~dp0
rem --no-open: do not launch the browser; log to data\server-out.log
node server\index.js --no-open >> data\server-out.log 2>&1
