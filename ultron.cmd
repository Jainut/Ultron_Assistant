@echo off
setlocal
set "ULTRON_ROOT=%~dp0"
if exist "%~dp0ultron.env.cmd" call "%~dp0ultron.env.cmd"
set "ULTRON_ENV_LOADED=1"
node "%~dp0bin\ultron.cjs" %*
endlocal
