$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\dinga\Projects\paperclip'
$forkRepo = Join-Path $repo 'packages\paperclip-fork'
$zKey = '582aa918cc194bdba2453e11c9f2080e.RU9NrpNKFOoqT5QD'
$complexityRouterId = '093ee390-cfbf-4129-81d6-aeeb638c7d71'
$reviewerId = 'eace3a19-bded-4b90-827e-cfc00f3900bd'
$diffGuardianId = '79641900-921d-400f-8eba-63373f5c0e17'
$issueIdentifier = 'SHO-44'

function Wait-Port([int]$Port, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(1000, $false) -and $client.Connected) {
        $client.EndConnect($iar)
        $client.Close()
        return $true
      }
      $client.Close()
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

function Invoke-Json([string]$Method, [string]$Uri, $Body = $null) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers @{ 'Content-Type' = 'application/json' }
  }

  $json = $Body | ConvertTo-Json -Depth 20
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers @{ 'Content-Type' = 'application/json' } -Body $json
}

$paperclipLog = Join-Path $repo 'paperclip-live.log'
$paperclipErr = Join-Path $repo 'paperclip-live.err.log'
$proxyLog = Join-Path $repo 'closedloop-live.log'
$proxyErr = Join-Path $repo 'closedloop-live.err.log'
$bridgeLog = Join-Path $repo 'bridge-live.log'
$bridgeErr = Join-Path $repo 'bridge-live.err.log'
$logs = @($paperclipLog, $paperclipErr, $proxyLog, $proxyErr, $bridgeLog, $bridgeErr)

foreach ($log in $logs) {
  if (Test-Path $log) {
    Remove-Item $log -Force
  }
}

$jobs = @()

try {
  $jobs += Start-Job -Name 'paperclip-server' -ArgumentList $forkRepo, $paperclipLog, $paperclipErr -ScriptBlock {
    param($wd, $outLog, $errLog)
    $env:PAPERCLIP_MIGRATION_PROMPT = 'never'
    $env:PAPERCLIP_MIGRATION_AUTO_APPLY = 'true'
    Set-Location $wd
    pnpm --filter @paperclipai/server dev *> $outLog 2> $errLog
  }

  $jobs += Start-Job -Name 'closedloop-proxy' -ArgumentList $repo, $zKey, $proxyLog, $proxyErr -ScriptBlock {
    param($wd, $key, $outLog, $errLog)
    $env:Z_AI_API_KEY = $key
    Set-Location $wd
    node dist/index.js *> $outLog 2> $errLog
  }

  $jobs += Start-Job -Name 'closedloop-bridge' -ArgumentList (Join-Path $repo 'packages\bridge'), $zKey, $bridgeLog, $bridgeErr -ScriptBlock {
    param($wd, $key, $outLog, $errLog)
    $env:Z_AI_API_KEY = $key
    Set-Location $wd
    node dist/index.js *> $outLog 2> $errLog
  }

  if (-not (Wait-Port 3100 240)) {
    throw 'Paperclip server did not start on port 3100.'
  }
  if (-not (Wait-Port 3201 120)) {
    throw 'ClosedLoop proxy did not start on port 3201.'
  }
  if (-not (Wait-Port 3202 120)) {
    throw 'ClosedLoop bridge did not start on port 3202.'
  }

  $issue = Invoke-Json 'GET' "http://127.0.0.1:3100/api/issues/$issueIdentifier"
  if ($issue.data) { $issue = $issue.data }
  if (-not $issue.id) {
    throw "Could not load issue $issueIdentifier."
  }

  Write-Host "Loaded issue $($issue.identifier): $($issue.title)"
  Write-Host "Current status: $($issue.status)"

  Invoke-Json 'PATCH' ("http://127.0.0.1:3100/api/issues/{0}" -f $issue.id) @{
    assigneeAgentId = $complexityRouterId
    status = 'in_progress'
  } | Out-Null

  Start-Sleep -Seconds 2

  $routerResponse = Invoke-Json 'POST' 'http://127.0.0.1:3201/' @{
    model = 'qwen3:4b'
    stream = $false
    agentId = $complexityRouterId
    issueId = $issue.id
    messages = @(
      @{ role = 'system'; content = 'You are the Complexity Router agent.' }
      @{ role = 'user'; content = 'Classify and process the assigned issue.' }
    )
  }

  Write-Host "Complexity Router response: $($routerResponse.message.content)"

  $reviewerTriggered = $false
  $diffTriggered = $false
  $prUrl = $null
  $lastAssignee = ''
  $lastStatus = ''
  $deadline = (Get-Date).AddMinutes(35)

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10

    $current = Invoke-Json 'GET' ("http://127.0.0.1:3100/api/issues/{0}" -f $issue.id)
    if ($current.data) { $current = $current.data }

    $comments = Invoke-Json 'GET' ("http://127.0.0.1:3100/api/issues/{0}/comments" -f $issue.id)
    if ($comments.data) { $comments = $comments.data }
    if ($comments.comments) { $comments = $comments.comments }

    if ($current.assigneeAgentId -ne $lastAssignee -or $current.status -ne $lastStatus) {
      Write-Host ("{0:u} assignee={1} status={2}" -f (Get-Date), $current.assigneeAgentId, $current.status)
      $lastAssignee = $current.assigneeAgentId
      $lastStatus = $current.status
    }

    foreach ($comment in @($comments)) {
      if ($comment.body -match 'https://github.com/\S+/pull/\d+') {
        $prUrl = $matches[0]
        break
      }
      if ($comment.body -match 'PR created.*?(https://\S+)') {
        $prUrl = $matches[1]
        break
      }
    }

    if ($prUrl) {
      Write-Host "PR created: $prUrl"
      break
    }

    if (-not $reviewerTriggered -and $current.assigneeAgentId -eq $reviewerId) {
      $reviewerResponse = Invoke-Json 'POST' 'http://127.0.0.1:3201/' @{
        model = 'glm-4.7-flash:latest'
        stream = $false
        agentId = $reviewerId
        issueId = $issue.id
        messages = @(
          @{ role = 'system'; content = 'You are the Reviewer agent.' }
          @{ role = 'user'; content = 'Review the assigned issue.' }
        )
      }

      Write-Host "Reviewer response: $($reviewerResponse.message.content)"
      $reviewerTriggered = $true
    }

    if (-not $diffTriggered -and $current.assigneeAgentId -eq $diffGuardianId) {
      $diffResponse = Invoke-Json 'POST' 'http://127.0.0.1:3201/' @{
        model = 'qwen3:4b'
        stream = $false
        agentId = $diffGuardianId
        issueId = $issue.id
        messages = @(
          @{ role = 'system'; content = 'You are the Diff Guardian agent.' }
          @{ role = 'user'; content = 'Validate the changes and create the PR if approved.' }
        )
      }

      Write-Host "Diff Guardian response: $($diffResponse.message.content)"
      $diffTriggered = $true
    }
  }

  if (-not $prUrl) {
    Write-Host 'Timed out waiting for PR creation. Showing recent logs.'
    foreach ($log in $logs) {
      if (Test-Path $log) {
        Write-Host "--- $log ---"
        Get-Content $log -Tail 80
      }
    }
    throw 'PR was not created before timeout.'
  }

  Write-Host "SUCCESS: $prUrl"
} finally {
  foreach ($job in $jobs) {
    try { Stop-Job $job -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Remove-Job $job -Force -ErrorAction SilentlyContinue | Out-Null } catch {}
  }
}
