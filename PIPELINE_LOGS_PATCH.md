# Pipeline Logs UI Patch

## Overview
This patch adds a **Pipeline Logs** page to the Paperclip UI for monitoring ClosedLoop agent runs in real-time.

## Files Changed

### 1. New Page Component
**File:** `packages/paperclip-fork/ui/src/pages/PipelineLogs.tsx`
- New page that displays live and recent agent runs
- Auto-refreshes every 5 seconds
- Shows agent name, issue being worked on, status, and timestamp
- Tabbed interface: "Live Runs" and "Recent Runs"

### 2. App Routes
**File:** `packages/paperclip-fork/ui/src/App.tsx`
- Added import for `PipelineLogs` component
- Added route: `/pipeline-logs`

### 3. Sidebar Navigation
**File:** `packages/paperclip-fork/ui/src/components/Sidebar.tsx`
- Added `Terminal` icon from lucide-react
- Added "Pipeline Logs" navigation item under "Work" section
- Shows live run count badge

## Features

### Live Runs Tab
- Shows all currently active agent runs
- Displays:
  - Agent name
  - Issue identifier (if assigned)
  - Status badge (queued/running/completed/failed)
  - Start time
- Auto-refreshes every 5 seconds

### Recent Runs Tab
- Shows last 50 completed/failed runs
- Scrollable list (600px height)
- Displays:
  - Agent name
  - Issue identifier and title
  - Status badge
  - Completion time

## Usage

1. **Access the page:**
   - Click "Pipeline Logs" in the sidebar under "Work" section
   - Or navigate to: `/:companyPrefix/pipeline-logs`

2. **Monitor runs:**
   - Live Runs tab shows active agents
   - Recent Runs tab shows history
   - Auto-refresh can be toggled on/off
   - Manual refresh button available

3. **Track ClosedLoop activity:**
   - Watch as Complexity Router → Strategist → Tech Lead → Local Builder → Reviewer flow progresses
   - See build results in real-time
   - Monitor for failed runs

## API Endpoints Used

- `GET /api/companies/:companyId/live-runs` - Fetch active runs
- `GET /api/companies/:companyId/heartbeat-runs?limit=50` - Fetch recent runs

## Visual Design

- Uses existing Paperclip UI components (Card, Badge, Tabs, etc.)
- Matches existing design system
- Status icons:
  - 🔵 Clock icon for queued/running
  - 🟢 CheckCircle for completed
  - 🔴 XCircle for failed
  - 🟡 AlertCircle for other states

## Testing

To test:
1. Start Paperclip UI
2. Assign an issue to an agent
3. Navigate to Pipeline Logs
4. Watch the live runs appear and update
5. Verify auto-refresh works (toggle on/off)

## Future Enhancements

Potential improvements:
- Click on a run to see detailed transcript
- Filter by agent name
- Filter by issue
- Search functionality
- Export logs
- Build output viewer
- Error highlighting
- Run duration tracking
