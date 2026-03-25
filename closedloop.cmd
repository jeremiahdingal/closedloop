@echo off
setlocal enabledelayedexpansion
title ClosedLoop Control Panel
color 0A

:MENU
cls
echo.
echo  ============================================
echo    ClosedLoop - AI Agent Control Panel
echo  ============================================
echo.
echo    [1] Start All   (Ollama + Paperclip + ClosedLoop)
echo    [2] Stop All
echo    [3] Restart All
echo    [4] Status Check
echo    [5] View ClosedLoop Logs (live)
echo    [6] Wake Agent Manually
echo    [7] Build RAG Index
echo    [8] Start ClosedLoop Only (npm start)
echo    [9] Exit
echo.
set /p choice="  Select: "

if "%choice%"=="1" goto START
if "%choice%"=="2" goto STOP
if "%choice%"=="3" goto RESTART
if "%choice%"=="4" goto STATUS
if "%choice%"=="5" goto LOGS
if "%choice%"=="6" goto WAKE
if "%choice%"=="7" goto RAG
if "%choice%"=="8" goto START_CLOSEDLOOP
if "%choice%"=="9" exit
goto MENU

:START
cls
echo.
echo  [*] Starting ClosedLoop...
echo.

:: 1. Ollama
echo  [1/3] Starting Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if %errorlevel%==0 (
    echo        Already running.
) else (
    start "" /B "C:\Users\dinga\AppData\Local\Programs\Ollama\ollama.exe" serve >nul 2>&1
    timeout /t 3 /nobreak >nul
    echo        Started.
)

:: 2. Paperclip
echo  [2/3] Starting Paperclip...
set PPC_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3100 "') do set PPC_PID=%%a
if defined PPC_PID (
    echo        Already running on :3100 ^(PID %PPC_PID%^).
) else (
    start "Paperclip" /MIN cmd /c paperclipai run ^>C:\Users\dinga\Projects\paperclip\paperclip-out.log 2^>^&1
    timeout /t 15 /nobreak >nul
    echo        Started on :3100.
)
set PPC_PID=

:: 3. ClosedLoop
echo  [3/3] Starting ClosedLoop...
:: Load secrets from .env if it exists
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)
if not defined LLM_MODEL set LLM_MODEL=deepcoder:14b
if not defined LLM_MODEL_BURST set LLM_MODEL_BURST=qwen3-coder:30b
set PROXY_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do set PROXY_PID=%%a
if defined PROXY_PID (
    echo        Already running on :3201 ^(PID %PROXY_PID%^).
) else (
    powershell -Command "$env:Z_AI_API_KEY='%Z_AI_API_KEY%'; $env:LLM_MODEL='%LLM_MODEL%'; $env:LLM_MODEL_BURST='%LLM_MODEL_BURST%'; Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory 'C:\Users\dinga\Projects\paperclip' -WindowStyle Hidden -RedirectStandardOutput 'closedloop-out.log' -RedirectStandardError 'closedloop-err.log'"
    timeout /t 2 /nobreak >nul
    echo        Started on :3201.
)
set PROXY_PID=

echo.
echo  [OK] All systems started.
echo.
pause
goto MENU

:STOP
cls
echo.
echo  [*] Stopping ClosedLoop...
echo.

:: Stop ClosedLoop
echo  [1/3] Stopping ClosedLoop...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3201 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
    echo        Killed PID %%a
)
echo        ClosedLoop stopped.

:: Stop Paperclip
echo  [2/3] Stopping Paperclip...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3100 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
    echo        Killed PID %%a
)
echo        Paperclip stopped.

:: Stop Ollama
echo  [3/3] Stopping Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if %errorlevel%==0 (
    taskkill /IM ollama.exe /F >nul 2>&1
    echo        Ollama stopped.
) else (
    echo        Not running.
)

echo.
echo  [OK] All systems stopped.
echo.
pause
goto MENU

:RESTART
cls
echo.
echo  [*] Restarting...
echo.

:: Stop ClosedLoop
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3201 " 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo  ClosedLoop stopped.
timeout /t 2 /nobreak >nul

:: Stop Paperclip
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3100 " 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo  Paperclip stopped.
timeout /t 2 /nobreak >nul

:: Start ClosedLoop
powershell -Command "Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory 'C:\Users\dinga\Projects\paperclip' -WindowStyle Hidden -RedirectStandardOutput 'closedloop-out.log' -RedirectStandardError 'closedloop-err.log'"
timeout /t 2 /nobreak >nul
echo  ClosedLoop restarted on :3201.

:: Start Paperclip
start "Paperclip" /MIN cmd /c paperclipai run ^>C:\Users\dinga\Projects\paperclip\paperclip-out.log 2^>^&1
timeout /t 15 /nobreak >nul
echo  Paperclip restarted on :3100.

:: Verify all
echo.
call :STATUS_INLINE
echo.
pause
goto MENU

:STATUS
cls
echo.
call :STATUS_INLINE
echo.
pause
goto MENU

:STATUS_INLINE
echo  ============================================
echo    System Status
echo  ============================================
echo.

:: Ollama
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if %errorlevel%==0 (
    echo    Ollama GPU :11434    [RUNNING]
) else (
    echo    Ollama GPU :11434    [STOPPED]
)

:: Paperclip
set PPC_FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3100 " 2^>nul') do set PPC_FOUND=1
if %PPC_FOUND%==1 (
    echo    Paperclip  :3100     [RUNNING]
) else (
    echo    Paperclip  :3100     [STOPPED]
)

:: ClosedLoop
set PRX_FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3201 " 2^>nul') do set PRX_FOUND=1
if %PRX_FOUND%==1 (
    echo    ClosedLoop :3201     [RUNNING]
) else (
    echo    ClosedLoop :3201     [STOPPED]
)

echo.
echo  ----------- Loaded Models -----------
curl -s http://localhost:11434/api/ps 2>nul | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{try{const d=JSON.parse(Buffer.concat(c));(d.models||[]).forEach(m=>console.log('    '+m.name+' ('+Math.round(m.size/1e9)+'GB, VRAM:'+Math.round((m.size_vram||0)/1e9)+'GB)'));}catch{console.log('    (none or ollama down)');}})" 2>nul

echo.
echo  ----------- Active Agents ----------
curl -s "http://127.0.0.1:3100/api/companies/ac5c469b-1f81-4f1f-9061-1dd9033ec831/agents" 2>nul | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{try{const d=JSON.parse(Buffer.concat(c));const agents=d.agents||d.data||d||[];agents.forEach(a=>{const s=a.status||'idle';const hb=a.runtimeConfig?.heartbeat?.heartbeatSec||'?';console.log('    '+a.name.padEnd(16)+' ['+s+']  hb:'+hb+'s');});}catch{console.log('    (paperclip down)');}});" 2>nul

echo.
echo  ----------- Open Issues ------------
curl -s "http://127.0.0.1:3100/api/companies/ac5c469b-1f81-4f1f-9061-1dd9033ec831/issues?status=todo,in_progress" 2>nul | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{try{const d=JSON.parse(Buffer.concat(c));const issues=d.issues||d.data||d||[];issues.forEach(i=>console.log('    '+i.identifier+' ['+i.status+'] '+i.title?.slice(0,50)));}catch{console.log('    (paperclip down)');}});" 2>nul

goto :eof

:LOGS
cls
echo.
echo  [*] ClosedLoop logs (Ctrl+C to stop)
echo  ============================================
echo.
powershell -Command "Get-Content 'C:\Users\dinga\Projects\paperclip\closedloop-out.log' -Wait -Tail 50"
goto MENU

:WAKE
cls
echo.
echo  ============================================
echo    Wake Agent
echo  ============================================
echo.
echo    [1] Complexity Router
echo    [2] Strategist (CTO)
echo    [3] Tech Lead
echo    [4] Local Builder
echo    [5] Reviewer
echo    [6] Diff Guardian
echo    [7] Visual Reviewer
echo    [8] Sentinel
echo    [9] Deployer
echo    [0] Back
echo.
set /p agent="  Select agent: "

set AGENT_ID=
if "%agent%"=="1" set AGENT_ID=&set AGENT_NAME=Complexity Router
if "%agent%"=="2" set AGENT_ID=a90b07a4-f18c-4509-9d7b-b9f16eb098d6&set AGENT_NAME=Strategist
if "%agent%"=="3" set AGENT_ID=dad994d7-5d3e-4101-ae57-82c7be9b778b&set AGENT_NAME=Tech Lead
if "%agent%"=="4" set AGENT_ID=caf931bf-516a-409f-813e-a29e14decb10&set AGENT_NAME=Local Builder
if "%agent%"=="5" set AGENT_ID=eace3a19-bded-4b90-827e-cfc00f3900bd&set AGENT_NAME=Reviewer
if "%agent%"=="6" set AGENT_ID=79641900-921d-400f-8eba-63373f5c0e17&set AGENT_NAME=Diff Guardian
if "%agent%"=="7" set AGENT_ID=787cbd9e-d10b-4bca-b486-e7f5fd99d184&set AGENT_NAME=Visual Reviewer
if "%agent%"=="8" set AGENT_ID=c7fb4dae-8ac3-4795-b1f6-d14db2021035&set AGENT_NAME=Sentinel
if "%agent%"=="9" set AGENT_ID=5e234916-47ef-41a2-8c07-e9376ee6aa9c&set AGENT_NAME=Deployer
if "%agent%"=="0" goto MENU

if not defined AGENT_ID (
    echo  Invalid selection.
    pause
    goto WAKE
)
if "%AGENT_ID%"=="" (
    echo  %AGENT_NAME% has no UUID yet - provision it in Paperclip UI first.
    pause
    goto WAKE
)

set /p reason="  Reason (optional): "
if "%reason%"=="" set reason=Manual wakeup

echo.
echo  Waking %AGENT_NAME%...
curl -s -X POST "http://127.0.0.1:3100/api/agents/%AGENT_ID%/wakeup" -H "Content-Type: application/json" -d "{\"reason\":\"%reason%\"}" | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const d=JSON.parse(Buffer.concat(c));console.log('  Run: '+(d.id||'?').slice(0,8)+' | Status: '+(d.status||'?'));});"
echo.
pause
goto MENU

:RAG
cls
echo.
echo  ============================================
echo    Build RAG Index
echo  ============================================
echo.
echo  This will scan your codebase and build the RAG index.
echo  Run this when you add/modify files in your project.
echo.
pause
echo.
echo  Building RAG index...
echo.
call npm run rag-index
echo.
echo  [OK] RAG index built.
echo.
pause
goto MENU

:START_CLOSEDLOOP
cls
echo.
echo  ============================================
echo    Start ClosedLoop (npm start)
echo  ============================================
echo.
echo  Starting ClosedLoop server on :3201...
echo.

:: Check if already running
set PROXY_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do set PROXY_PID=%%a
if defined PROXY_PID (
    echo  ClosedLoop already running on :3201 ^(PID %PROXY_PID%^).
    pause
    goto MENU
)

:: Start ClosedLoop
echo  Starting ClosedLoop...
start "ClosedLoop" /MIN cmd /c npm start ^>C:\Users\dinga\Projects\paperclip\closedloop-out.log 2^>^&1
timeout /t 3 /nobreak >nul

:: Verify it started
set PROXY_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do set PROXY_PID=%%a
if defined PROXY_PID (
    echo  ClosedLoop started on :3201 ^(PID %PROXY_PID%^).
) else (
    echo  Waiting for ClosedLoop to start...
    timeout /t 5 /nobreak >nul
)

echo.
echo  [OK] ClosedLoop started.
echo.
pause
goto MENU
