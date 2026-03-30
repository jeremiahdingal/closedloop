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
echo    [9] Trigger Background Checker NOW
echo    [A] Login to OpenAI (OAuth)
echo    [0] Exit
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
if "%choice%"=="9" goto TRIGGER_CHECKER
if /I "%choice%"=="A" goto OAUTH_OPENAI
if "%choice%"=="0" exit
goto MENU

:START
cls
echo.
echo  [*] Starting ClosedLoop...
echo.

call :BUILD_RUNTIME
if errorlevel 1 (
    echo.
    echo  [ERROR] Build failed. Start aborted to avoid stale dist output.
    echo.
    pause
    goto MENU
)

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
    start "Paperclip" /MIN cmd /c paperclipai run ^>C:\Users\dinga\Projects\closedloop\paperclip-out.log 2^>^&1
    timeout /t 15 /nobreak >nul
    echo        Started on :3100.
)
set PPC_PID=

:: 3. ClosedLoop
echo  [3/3] Starting ClosedLoop...
set PROXY_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do set PROXY_PID=%%a
if defined PROXY_PID (
    echo        Already running on :3201 ^(PID %PROXY_PID%^).
) else (
    :: Kill any stale node processes on 3201 first
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
    call :START_CLOSEDLOOP_PROCESS
)
set PROXY_PID=

echo.
echo  [OK] All systems started.
echo.
echo  NOTE: Background checker runs every 60s to wake assigned agents.
echo  Check logs with option [5] to see agent wakeups.
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

call :BUILD_RUNTIME
if errorlevel 1 (
    echo.
    echo  [ERROR] Build failed. Restart aborted to avoid stale dist output.
    echo.
    pause
    goto MENU
)

:: Stop ClosedLoop
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3201 " 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo  ClosedLoop stopped.
timeout /t 2 /nobreak >nul

:: Start ClosedLoop
call :START_CLOSEDLOOP_PROCESS
echo  ClosedLoop restart attempted.

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
echo  [*] ClosedLoop logs (press Q to return)
echo  ============================================
echo.
powershell -NoLogo -NoProfile -Command ^
  "$path='C:\Users\dinga\Projects\closedloop\closedloop-out.log';" ^
  "if (-not (Test-Path $path)) { New-Item -ItemType File -Path $path -Force | Out-Null };" ^
  "Write-Host 'Press Q to return to the menu.' -ForegroundColor Yellow;" ^
  "$fs=[System.IO.File]::Open($path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);" ^
  "$sr=New-Object System.IO.StreamReader($fs);" ^
  "$content=$sr.ReadToEnd();" ^
  "$lines=$content -split \"`r?`n\";" ^
  "$start=[Math]::Max(0,$lines.Length-50);" ^
  "for($i=$start;$i -lt $lines.Length;$i++){ if($lines[$i] -ne ''){ Write-Host $lines[$i] } };" ^
  "$fs.Seek(0,[System.IO.SeekOrigin]::End) | Out-Null;" ^
  "while($true){" ^
  "  while(-not $sr.EndOfStream){ Write-Host $sr.ReadLine() }" ^
  "  Start-Sleep -Milliseconds 400;" ^
  "  if([Console]::KeyAvailable){" ^
  "    $key=[Console]::ReadKey($true);" ^
  "    if($key.Key -eq 'Q'){ break }" ^
  "  }" ^
  "}" ^
  "$sr.Close(); $fs.Close();"
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

call :BUILD_RUNTIME
if errorlevel 1 (
    echo.
    echo  [ERROR] Build failed. Start aborted to avoid stale dist output.
    echo.
    pause
    goto MENU
)

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
call :START_CLOSEDLOOP_PROCESS

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

:START_CLOSEDLOOP_PROCESS
:: Load secrets from .env if it exists
if exist "%~dp0.env" (
    for /f "usebackq delims=" %%A in ("%~dp0.env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" (
            for /f "tokens=1,* delims==" %%B in ("%%A") do (
                set "%%B=%%C"
            )
        )
    )
)
if not defined LLM_MODEL set LLM_MODEL=deepcoder:14b
if not defined LLM_MODEL_BURST set LLM_MODEL_BURST=qwen3-coder:30b

start "ClosedLoop" /MIN cmd /c "cd /d C:\Users\dinga\Projects\closedloop && npm start > closedloop-out.log 2> closedloop-err.log"
timeout /t 5 /nobreak >nul

set PROXY_PID=
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":3201 "') do set PROXY_PID=%%a
if defined PROXY_PID (
    echo        Started on :3201 ^(PID %PROXY_PID%^).
) else (
    echo        ClosedLoop did not come up on :3201 yet. Check closedloop-err.log.
)
goto :eof

:BUILD_RUNTIME
echo  [build] Rebuilding ClosedLoop runtime...
call npm run build
if errorlevel 1 (
    echo  [build] Root build failed.
    exit /b 1
)

echo  [build] Rebuilding bridge runtime...
pushd packages\bridge >nul
call npm run build
if errorlevel 1 (
    popd >nul
    echo  [build] Bridge build failed.
    exit /b 1
)
popd >nul
echo  [build] Runtime builds complete.
exit /b 0

:TRIGGER_CHECKER
cls
echo.
echo  ============================================
echo    Trigger Background Checker NOW
echo  ============================================
echo.
echo  This will immediately wake up the background checker
echo  to process all assigned issues.
echo.
pause
echo.
echo  Triggering background checker...
echo.

:: Call the bridge's checkAssignedIssues via a direct API call
:: The bridge listens on 3201 but doesn't expose this endpoint
:: So we wake all agents with assigned issues directly

echo  Fetching assigned issues...
curl -s "http://127.0.0.1:3100/api/companies/ac5c469b-1f81-4f1f-9061-1dd9033ec831/issues?status=todo,in_progress" > "%TEMP%\assigned_issues.json"

:: Wake Strategist
echo  Waking Strategist...
curl -s -X POST "http://127.0.0.1:3100/api/agents/a90b07a4-f18c-4509-9d7b-b9f16eb098d6/wakeup" -H "Content-Type: application/json" -d "{\"reason\":\"Background checker trigger\"}" >nul
echo  Strategist woken.

:: Wake Local Builder
echo  Waking Local Builder...
curl -s -X POST "http://127.0.0.1:3100/api/agents/caf931bf-516a-409f-813e-a29e14decb10/wakeup" -H "Content-Type: application/json" -d "{\"reason\":\"Background checker trigger\"}" >nul
echo  Local Builder woken.

:: Wake Tech Lead
echo  Waking Tech Lead...
curl -s -X POST "http://127.0.0.1:3100/api/agents/dad994d7-5d3e-4101-ae57-82c7be9b778b/wakeup" -H "Content-Type: application/json" -d "{\"reason\":\"Background checker trigger\"}" >nul
echo  Tech Lead woken.

:: Wake Reviewer
echo  Waking Reviewer...
curl -s -X POST "http://127.0.0.1:3100/api/agents/eace3a19-bded-4b90-827e-cfc00f3900bd/wakeup" -H "Content-Type: application/json" -d "{\"reason\":\"Background checker trigger\"}" >nul
echo  Reviewer woken.

echo.
echo  [OK] All key agents woken. Check logs for processing.
echo.
pause
goto MENU

:OAUTH_OPENAI
cls
echo.
echo  ============================================
echo    OpenAI OAuth Login
echo  ============================================
echo.
echo  This will open your browser to sign in with
echo  your ChatGPT Plus/Pro account.
echo.
echo  The token will be saved to .env automatically.
echo.
pause
echo.
call npm run oauth:openai
echo.
pause
goto MENU
