@echo off
setlocal
rem agent-models-management quick launcher (ASCII only: cmd parses batch files in ANSI/GBK codepage)
rem usage:  ammp        start service (opens browser if already running)
rem         ammp stop   stop service
rem
rem Repo layout: <repo>\bin\ammp.cmd  ->  repo root is one level up.
rem If you copy this file elsewhere, hardcode AMMP_DIR to the repo path.
set "AMMP_DIR=%~dp0.."
set "AMMP_PORT=3210"
set "AMMP_URL=http://127.0.0.1:%AMMP_PORT%"

if /i "%~1"=="stop" goto :stop

curl -s -o NUL -m 2 "%AMMP_URL%/api/overview" >NUL 2>&1
if %errorlevel%==0 (
  echo [ammp] already running, opening browser: %AMMP_URL%
  start "" "%AMMP_URL%"
  exit /b 0
)

rem Launch fully hidden via wscript: a plain "start /min cmd" still shows a
rem console window, and the QUIC bridge must never pop one up either.
echo [ammp] starting service (hidden)...
wscript //nologo //B "%~dp0run_hidden.vbs" "%~dp0ammp_run.cmd"
ping -n 3 127.0.0.1 >NUL
curl -s -o NUL -m 2 "%AMMP_URL%/api/overview" >NUL 2>&1
if %errorlevel%==0 (
  echo [ammp] started: %AMMP_URL%
) else (
  echo [ammp] still starting, browser will open automatically. URL: %AMMP_URL%
)
exit /b 0

:stop
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%AMMP_PORT% " ^| findstr /C:"LISTENING"') do (
  set FOUND=1
  taskkill /PID %%a /F >NUL 2>&1 && echo [ammp] stopped pid %%a
)
if not defined FOUND echo [ammp] not running
rem also stop the QUIC bridge child (port 8787) if it lingers
for /f "tokens=5" %%b in ('netstat -ano ^| findstr /C:":8787 " ^| findstr /C:"LISTENING"') do (
  taskkill /PID %%b /F >NUL 2>&1 && echo [ammp] stopped bridge pid %%b
)
exit /b 0
