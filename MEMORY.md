# Shop Diary V3 — Persistent Project Memory

> Last updated: 2026-03-24
> Updated by: Claude (audit session)

---

## What This Project Is

Shop Diary V3 is a **cash-first, modern POS system** for small shops and cafes.
Baseline reference: Loyverse (https://loyverse.com). Goal: match every Loyverse core feature free, then exceed with better UX, open data, and Cloudflare-native infrastructure.

**Cash-only model**: No Stripe, no card gateway. The cashier presses "Confirm Payment Received" as a real-world assumption flag after physically collecting cash.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | Turborepo + Yarn workspaces |
| Web apps | Next.js 13.5.2 (dashboard @ :3200, cashier @ :3201) |
| Mobile | Expo 52 + React Native 0.72.6 |
| API | Cloudflare Workers + itty-router + Kysely + D1 (SQLite) |
| State | Zustand (user/shop) + TanStack React Query (server state) |
| Forms | React Hook Form + Zod |
| Styling | **Tamagui** — NO StyleSheet.create, NO Tailwind, NO CSS modules |
| Auth | JWT (jose) |
| IDs | ULID (ulidx) |
| Testing | Playwright (E2E), Vitest (API) |
| Language | TypeScript strict mode — ALL files .ts/.tsx |

---

## File Structure Conventions

```
packages/app/{feature}/screen.tsx     — shared cross-platform screen
packages/app/{feature}/dialogs/       — modals/sheets for that feature
packages/app/apiHooks/use{Entity}.ts  — TanStack Query hooks
packages/app/store/                   — Zustand stores
packages/app/types/db.types.ts        — DB row types
packages/app/types/schemas/           — Zod validation schemas
packages/ui/src/atoms/                — Button, Input, etc.
packages/ui/src/molecules/            — SimpleDialog, SimpleSheet, ImageUpload
packages/ui/src/organisms/            — AdvancedTable, TextInputController
packages/ui/src/templates/            — DashboardLayout
api/src/services/{domain}/            — Cloudflare Worker routes
```

**Package scope**: `@shop-diary/ui`, `@shop-diary/app`

---

## Naming Conventions

- Component props interfaces: `IMyComponentProps`
- Form interfaces: `IMyFeatureForm`
- DB types: `TEntity`, `TNewEntity`, `TEntityUpdate`
- API hooks: `useEntities()` → returns `{ entities, isLoading }`
- Route files: `{domain}.routes.ts`
- Schema files: `{domain}.schema.ts`

---

## Import Rules (critical for ClosedLoop agents)

```ts
// UI components
import Button from '@shop-diary/ui/src/atoms/Button'
import SimpleDialog from '@shop-diary/ui/src/molecules/SimpleDialog'
import AdvancedTable from '@shop-diary/ui/src/organisms/AdvancedTable'

// App shared
import { useUserStore } from 'app/store/useUserStore'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'
import { useCategories } from 'app/apiHooks/useCategories'

// Tamagui
import { YStack, XStack, Paragraph, H2, Label, Fieldset, Form } from 'tamagui'
import { uiSurface } from '@shop-diary/ui/src/theme/visualSystem'

// Icons
import * as icons from '@tamagui/lucide-icons'
```

**Always use `fetcherWithToken` for authenticated requests. Never bare `fetcher` for protected endpoints.**

---

## Dev URLs

| Service | URL |
|---------|-----|
| Dashboard web | http://localhost:3200 |
| Cashier web | http://localhost:3201 |
| API (Wrangler) | http://localhost:8787 |

---

## Decisions Made

| Date | Decision | Reason |
|------|----------|--------|
| 2026-03-24 | Cash-only payments (no card gateway) | Simplicity; operators confirm cash physically |
| 2026-03-24 | No tax system | Cash-only + small shops don't need tax calc in MVP |
| 2026-03-24 | Loyverse as baseline | Free, widely-used POS — good parity target |
| 2026-03-24 | Tamagui for all styling | Cross-platform (web + RN) with single codebase |

---

## Bug Log

| Date | Bug | Status | Fix |
|------|-----|--------|-----|
| 2026-03-24 | Edit Category dialog never opens | FIXED | `SimpleDialog` lacked `open`/`onOpenChange` props; added controlled mode |
| 2026-03-24 | Edit Item sheet crashes on render | FIXED | `Label` missing from tamagui import in `EditItemSheet.tsx` |
| 2026-03-24 | Delete category uses unauthenticated fetcher | OPEN | `categories/screen.tsx` uses bare `fetcher` for DELETE; should be `fetcherWithToken` |
| 2026-03-24 | Add category doesn't refresh list | OPEN | `AddCategoryDialog` has no query invalidation in `onSuccess` |

---

## Current Sprint

**Sprint 1 goal**: Get app functional end-to-end for cash sales

Priority order:
1. Fix remaining bugs (Epic 1)
2. Cash checkout flow (Epic 2) — makes app usable
3. Analytics dashboard (Epic 3)
4. Advanced inventory (Epic 7)

See `.claude/BACKLOG.md` for full epic/ticket list.

---

## ClosedLoop Integration

- ClosedLoop config: `C:\Users\dinga\Projects\paperclip\.claude\worktrees\stupefied-tereshkova\.paperclip\project.json`
- GitHub repo: `jeremiahdingal/shop-diary-v3`
- ClosedLoop feeds on **Paperclip Goals** (level: 'team') for epics — auto-decomposed into tickets
- Build gate command (FIXED 2026-03-24): `npx turbo run build --filter=@shop-diary/ui --filter=@shop-diary/app`
- `yarn build` previously failed — `@yarnpkg/plugin-workspace-tools` not installed, `yarn workspaces foreach` always errored
- Reflection memory saved to `.reflections/` in project root
- RAG index at `.paperclip/rag-index.json`

## ClosedLoop Quality Audit (2026-03-24)

Observed during first run with Epic 1 (bug fixes) and Epic 2 (cash checkout):

### Issues Found

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| Q1 | CRITICAL | Build gate always failed — `yarn workspaces foreach` requires missing Yarn plugin | FIXED: changed buildCommand to turbo |
| Q2 | HIGH | Epic decomposition race condition — same goal decomposed 2x creating duplicate tickets (SHO-64/65 AND SHO-66/67 for same bugs) | Open |
| Q3 | HIGH | Strategist loses issue context ~50% of time — outputs "No Comment History, Issue Context Missing" | Open |
| Q4 | HIGH | Strategist misidentifies tech stack — calls it "Supabase backend" and "Coffee Shop Inventory System" instead of Cloudflare D1 + Tamagui | Open |
| Q5 | MEDIUM | Wrong import paths — SHO-67 used `@shop-diary/app/utils/fetcher` instead of `app/utils/fetcherWithToken` | Will self-correct on retry |
| Q6 | MEDIUM | Wrong API signature — SHO-67 called `fetcherWithToken(url, { method })` instead of `fetcherWithToken({ method, url })` | Will self-correct on retry |
| Q7 | MEDIUM | Wrong file placement — SHO-68 put order route in `api/src/services/shop/complete/` instead of `api/src/services/orders/` | Will self-correct on retry |
| Q8 | MEDIUM | Wrong Kysely syntax — SHO-68 used string SQL in `.set({ stock: 'stock - quantity' })` instead of Kysely expression | Will self-correct on retry |
| Q9 | LOW | `PROJECT_STRUCTURE.md` missing — context builder falls back to directory scan every time | Create this file |
| Q10 | LOW | Bug fixes uncommitted when ClosedLoop switched branches — git stash discarded edits | FIXED: now commit first |

### Root Cause of Q3/Q4 (Strategist context loss)
The Strategist is built as a general agent and doesn't see the specific issue title/description when processing. This is a ClosedLoop proxy-server.ts context injection issue. The Strategist receives directory structure but not the actual issue content in some code paths.

### What Worked Well
- Complexity Router correctly scored and routed all tickets (0/10 = bug/simple, routes to Strategist)
- Delegation chain worked: Complexity Router → Strategist → Tech Lead → Local Builder
- Local Builder extracted FILE: blocks and wrote files (correct mechanism)
- Build retry loop (up to 20 passes) prevented infinite failures
- Epic decomposer generated correct ticket count (2 for bugs, 7 for cash flow)
- Strategist DID successfully delegate to Tech Lead in most cases once context was available
