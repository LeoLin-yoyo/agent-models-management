@echo off
rem agent-models-management launcher (double-click friendly).
rem Starts the service FULLY HIDDEN (no console window) via wscript, then exits
rem immediately. The service opens the browser itself; the QUIC bridge it spawns
rem also runs windowless (pythonw + windowsHide).
rem
rem Use this file for double-click; or `ammp` / `ammp stop` from any terminal.
setlocal
set "AMMP_DIR=%~dp0"
set "AMMP_URL=http://127.0.0.1:3210"

rem If already running, just open the browser.
curl -s -o NUL -m 2 "%AMMP_URL%/api/overview" >NUL 2>&1
if %errorlevel%==0 (
  start "" "%AMMP_URL%"
  exit /b 0
)

wscript //nologo //B "%AMMP_DIR%bin\run_hidden.vbs" "%AMMP_DIR%bin\ammp_run.cmd"
exit /b 0
