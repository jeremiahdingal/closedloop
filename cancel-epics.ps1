# Cancel all Epic 1 and Epic 2 goals and tickets

$companyId = "ac5c469b-1f81-4f1f-9061-1dd9033ec831"
$baseUrl = "http://localhost:3100"

Write-Host "Fetching all issues..." -ForegroundColor Cyan
$issues = Invoke-RestMethod -Uri "$baseUrl/api/companies/$companyId/issues"

# Find Epic 1 and Epic 2 goals
$epic1 = $issues | Where-Object { $_.identifier -eq 'SHO-132' }
$epic2 = $issues | Where-Object { $_.identifier -eq 'SHO-133' }

Write-Host "Found Epic 1: $($epic1.identifier)" -ForegroundColor Yellow
Write-Host "Found Epic 2: $($epic2.identifier)" -ForegroundColor Yellow

# Get all tickets that belong to these epics (by goalId)
$epic1GoalId = $epic1.goalId
$epic2GoalId = $epic2.goalId

$epic1Tickets = $issues | Where-Object { $_.goalId -eq $epic1GoalId }
$epic2Tickets = $issues | Where-Object { $_.goalId -eq $epic2GoalId }

Write-Host ""
Write-Host "Cancelling Epic 1 and its $($epic1Tickets.Count) tickets..." -ForegroundColor Cyan
foreach ($ticket in $epic1Tickets) {
    try {
        Invoke-RestMethod -Uri "$baseUrl/api/issues/$($ticket.id)" -Method Patch -ContentType 'application/json' -Body '{"status":"cancelled"}' | Out-Null
        Write-Host "  Cancelled $($ticket.identifier): $($ticket.title)" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to cancel $($ticket.identifier): $($_.Exception.Message)" -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "Cancelling Epic 2 and its $($epic2Tickets.Count) tickets..." -ForegroundColor Cyan
foreach ($ticket in $epic2Tickets) {
    try {
        Invoke-RestMethod -Uri "$baseUrl/api/issues/$($ticket.id)" -Method Patch -ContentType 'application/json' -Body '{"status":"cancelled"}' | Out-Null
        Write-Host "  Cancelled $($ticket.identifier): $($ticket.title)" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to cancel $($ticket.identifier): $($_.Exception.Message)" -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Cleanup Complete!" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Cyan
