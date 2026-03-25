# ClosedLoop: Shop Diary V3 Context

> Last updated: 2026-03-24
> Quick reference for ClosedLoop agents working on shop-diary-v3

---

## Target Project

| Field | Value |
|-------|-------|
| Name | Shop Diary V3 |
| Workspace | `C:\Users\dinga\Projects\shop-diary-v3` |
| GitHub repo | `jeremiahdingal/shop-diary-v3` |
| Build command | `yarn build` |
| Dev servers | `yarn dev` (dashboard :3200, cashier :3201) |
| API dev | `cd api && npx wrangler dev` (:8787) |

---

## Tech Stack (critical for code generation)

- **Styling**: Tamagui — NOT StyleSheet.create, NOT Tailwind, NOT CSS modules
- **Web framework**: Next.js 13.5.2 (apps are thin wrappers — logic lives in `packages/app/`)
- **State**: Zustand (client) + TanStack React Query (server)
- **Forms**: React Hook Form + Zod resolvers
- **API**: Cloudflare Workers + itty-router + Kysely + D1 (SQLite)
- **Auth**: JWT via jose; token in Zustand `useUserStore`
- **IDs**: ULID via ulidx

---

## Critical Import Patterns

```ts
// Authenticated API calls — ALWAYS use this, never bare fetcher
import { fetcherWithToken } from 'app/utils/fetcherWithToken'

// UI atoms/molecules
import Button from '@shop-diary/ui/src/atoms/Button'
import SimpleDialog from '@shop-diary/ui/src/molecules/SimpleDialog'
import SimpleSheet from '@shop-diary/ui/src/molecules/SimpleSheet'
import AdvancedTable from '@shop-diary/ui/src/organisms/AdvancedTable'

// Theme
import { uiSurface } from '@shop-diary/ui/src/theme/visualSystem'

// Tamagui layout/text primitives
import { YStack, XStack, Paragraph, H2, H3, Label, Fieldset, Form, Spacer } from 'tamagui'

// Icons
import * as icons from '@tamagui/lucide-icons'

// User store / token
import { useUserStore } from 'app/store/useUserStore'
const { token } = useUserStore()
```

---

## File Patterns (where to put new code)

| What | Where |
|------|-------|
| New screen | `packages/app/dashboard/{feature}/screen.tsx` |
| Add/Edit modal | `packages/app/dashboard/{feature}/dialogs/` |
| API hook | `packages/app/apiHooks/use{Entity}.ts` |
| API route | `api/src/services/{domain}/{domain}.routes.ts` |
| API schema | `api/src/services/{domain}/{domain}.schema.ts` |
| API service | `api/src/services/{domain}/{domain}.service.ts` |
| New UI component | `packages/ui/src/molecules/` or `atoms/` |
| Nav items | `packages/ui/src/templates/DashboardLayout.tsx` |

---

## API Conventions

- Base URL in dev: `http://localhost:8787`
- All routes prefixed by domain: `/categories`, `/items`, `/orders`, etc.
- Auth: Bearer token in Authorization header (handled by `fetcherWithToken`)
- IDs: ULID strings
- Timestamps: ISO 8601 strings
- Pattern for new service:

```ts
// routes file registers with itty-router
router.get('/domain', authMiddleware, listHandler)
router.post('/domain/create', authMiddleware, createHandler)
router.patch('/domain/:id', authMiddleware, updateHandler)
router.delete('/domain/:id', authMiddleware, deleteHandler)
```

---

## Product Decisions (do not override these)

1. **Cash only** — no payment gateway, no Stripe. Cashier presses "Confirm Cash Received"
2. **No tax system** — excluded from MVP; cash-only model doesn't require it
3. **No multi-currency** — single currency per shop
4. **Free advanced features** — inventory, staff tracking are free (Loyverse charges for these)

---

## Backlog Location

Full epic/ticket backlog: `C:\Users\dinga\Projects\shop-diary-v3\.claude\BACKLOG.md`
Project memory: `C:\Users\dinga\Projects\shop-diary-v3\.claude\MEMORY.md`

---

## Recent Fixes (2026-03-24)

1. `packages/ui/src/molecules/SimpleDialog.tsx` — Added controlled `open`/`onOpenChange` props; made `triggerElement` optional
2. `packages/app/dashboard/items/dialogs/EditItemSheet.tsx` — Added `Label` to tamagui import (line 16)
3. `.paperclip/project.json` — Updated workspace/repo to shop-diary-v3; updated styling tech stack entry to Tamagui
