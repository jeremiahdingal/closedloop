@echo off
title ClosedLoop Bridge
color 0A

echo.
echo ============================================
echo   ClosedLoop Bridge - Starting...
echo ============================================
echo.

cd /d "%~dp0packages\bridge"

echo [1] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found
    pause
    exit /b 1
)
echo OK

echo.
echo [2] Building...
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed
    pause
    exit /b 1
)
echo OK

echo.
echo [3] Starting bridge server on port 3202...
echo.
node dist/index.js

pause
