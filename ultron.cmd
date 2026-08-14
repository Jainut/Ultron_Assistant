@echo off
setlocal
set "ULTRON_ROOT=%~dp0"
if exist "%~dp0ultron.env.cmd" call "%~dp0ultron.env.cmd"
node "%~dp0apps\core\dist\src\index.js" %*
endlocal
