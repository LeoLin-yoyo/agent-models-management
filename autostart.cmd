@echo off
rem agent-models-management silent autostart (normally invoked hidden by
rem ammp_silent.vbs at logon; safe to run/double-click directly too).
rem guard: exit if ammp already running on 3210
netstat -ano | findstr /C:":3210 " | findstr /C:"LISTENING" >nul && exit /b 0
rem Launch via the shared hidden launcher so no console window ever shows,
rem even if this file is double-clicked. --no-open: don't launch the browser.
wscript //nologo //B "%~dp0bin\run_hidden.vbs" "%~dp0bin\ammp_run.cmd" --no-open
exit /b 0
