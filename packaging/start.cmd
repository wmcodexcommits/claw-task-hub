@echo off
setlocal
set "PACKAGE_ROOT=%~dp0"
set "CLAW_TASK_HUB_SERVE_UI=1"
if not defined CLAW_TASK_HUB_HOST set "CLAW_TASK_HUB_HOST=127.0.0.1"
if not defined PORT set "PORT=4781"
echo Claw Task Hub is starting at http://%CLAW_TASK_HUB_HOST%:%PORT%
"%PACKAGE_ROOT%runtime\bun.exe" "%PACKAGE_ROOT%server\index.ts"
