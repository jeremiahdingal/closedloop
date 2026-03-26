# Create Epic 1 for testing Epic Decoder

$companyId = "ac5c469b-1f81-4f1f-9061-1dd9033ec831"
$baseUrl = "http://localhost:3100"

$epic1 = @{
    title = "[Goal] Epic 1: Bug Fixes - Foundation for Cash POS"
    description = @"
Fix critical bugs blocking the Cash POS development. These are immediate priority fixes needed before implementing the cash checkout flow.

## Bugs to Fix:

1. **Fix SimpleDialog controlled mode** - Add `open?: boolean` and `onOpenChange?: (open: boolean) => void` props. When `open` is provided, use controlled mode instead of internal `useState`. Make `triggerElement` optional.

2. **Fix EditItemSheet missing Label import** - Add `Label` to tamagui import in `packages/app/dashboard/items/dialogs/EditItemSheet.tsx`

3. **Fix AddCategoryDialog query invalidation** - Add `useQueryClient` + `queryClient.invalidateQueries({ queryKey: ['categories'] })` in `onSuccess` callback

4. **Fix categories DELETE unauthenticated fetcher** - Use `fetcherWithToken` instead of bare `fetcher` for DELETE operations in categories

## Acceptance Criteria:
- All 4 bugs fixed
- Build passes without errors
- Categories can be added/edited/deleted without issues
- Dialogs open and close correctly
"@
    priority = "high"
    status = "todo"
} | ConvertTo-Json

Write-Host "Creating Epic 1..." -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/companies/$companyId/issues" -Method Post -ContentType 'application/json' -Body $epic1
    Write-Host "  Created $($response.identifier): $($response.title)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Epic 1 created! Now assign it to Complexity Router to test Epic Decoder." -ForegroundColor Yellow
} catch {
    Write-Host "  Failed: $($_.Exception.Message)" -ForegroundColor Red
}
