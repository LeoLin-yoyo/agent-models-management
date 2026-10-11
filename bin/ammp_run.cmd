@echo off
rem Hidden launch target for `ammp` / `start.bat` (invoked by bin\run_hidden.vbs
rem in a hidden window). Starts the service in the foreground of that hidden
rem console; the service opens the browser itself, and it spawns the QUIC
rem bridge with windowsHide + pythonw (so neither ever shows a window).
rem Extra args are forwarded (e.g. --no-open).
cd /d "%~dp0.."
node server\index.js %* >> data\server-out.log 2>&1
