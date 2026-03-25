# Shop Diary V3 — Project Structure

> **Purpose:** This file tells AI agents where files belong. Read before creating new files.

---

## 📁 Monorepo Layout

```
shop-diary-v3/
├── apps/                      # Application entry points (thin wrappers)
│   ├── dashboard-web/         # Dashboard web app (Next.js)
│   ├── cashier-web/           # Cashier web app (Next.js)
│   ├── dashboard-mobile/      # Dashboard mobile (Expo)
│   └── cashier-mobile/        # Cashier mobile (Expo)
│
├── packages/                  # Shared packages
│   ├── app/                   # Shared screens, hooks, stores, types
│   │   ├── apiHooks/          # TanStack Query hooks
│   │   ├── cashier/           # POS screens
│   │   ├── dashboard/         # Dashboard screens
│   │   ├── store/             # Zustand stores
│   │   ├── types/             # TypeScript types & Zod schemas
│   │   └── utils/             # Shared utilities
│   │
│   └── ui/                    # UI component library
│       └── src/
│           ├── atoms/         # Small components (Button, Input)
│           ├── molecules/     # Composite components (Dialog, Sheet)
│           ├── organisms/     # Complex components (Table, Cart)
│           ├── templates/     # Layout templates
│           └── theme/         # Theme system
│
├── api/                       # Cloudflare Workers API
│   └── src/
│       ├── services/          # Domain-specific routes
│       └── infra/             # DB, auth, middleware
│
└── .paperclip/                # ClosedLoop system files
```

---

## 📍 File Placement Rules

### Screens (React Native)

| Screen Type | Location | Example |
|-------------|----------|---------|
| Dashboard feature | `packages/app/dashboard/{feature}/screen.tsx` | `packages/app/dashboard/items/screen.tsx` |
| Cashier feature | `packages/app/cashier/{feature}/screen.tsx` | `packages/app/cashier/checkout/screen.tsx` |
| Auth screens | `packages/app/auth/{screen}/screen.tsx` | `packages/app/auth/login/screen.tsx` |

**Rule:** All screens in `packages/app/`, NOT in `apps/`

---

### Page Wrappers (Next.js)

| App | Location | Example |
|-----|----------|---------|
| Dashboard web | `apps/dashboard-web/pages/{feature}.tsx` | `apps/dashboard-web/pages/items.tsx` |
| Cashier web | `apps/cashier-web/pages/{feature}.tsx` | `apps/cashier-web/pages/checkout.tsx` |

**Pattern:**
```tsx
// apps/dashboard-web/pages/items.tsx
import ItemsScreen from '@shop-diary/app/dashboard/items/screen'
export default ItemsScreen
```

**Rule:** Page wrappers are THIN — just import and export the screen

---

### API Hooks (TanStack Query)

**Location:** `packages/app/apiHooks/use{Entity}.ts`

| Entity | Hook File |
|--------|-----------|
| Items | `packages/app/apiHooks/useItems.ts` |
| Shops | `packages/app/apiHooks/useShop.ts` |
| Orders | `packages/app/apiHooks/useOrders.ts` |
| Categories | `packages/app/apiHooks/useCategories.ts` |

**Pattern:**
```ts
// packages/app/apiHooks/useItems.ts
import { useQuery } from '@tanstack/react-query'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'

export function useItems() {
  return useQuery({
    queryKey: ['items'],
    queryFn: () => fetcherWithToken({ url: '/api/items' }),
  })
}
```

---

### Zustand Stores

**Location:** `packages/app/store/{name}.ts`

| Store | File |
|-------|------|
| User | `packages/app/store/useUserStore.ts` |
| Shop | `packages/app/store/useShopStore.ts` |
| Cart | `packages/app/store/useCartStore.ts` |

**Rule:** One store per file, named `use{Name}Store.ts`

---

### UI Components

| Component Type | Location | Examples |
|----------------|----------|----------|
| Atoms | `packages/ui/src/atoms/` | `Button.tsx`, `Input.tsx`, `Badge.tsx` |
| Molecules | `packages/ui/src/molecules/` | `SimpleDialog.tsx`, `CategoryTab.tsx` |
| Organisms | `packages/ui/src/organisms/` | `AdvancedTable.tsx`, `CartView.tsx` |
| Templates | `packages/ui/src/templates/` | `DashboardLayout.tsx` |

**Rule:** Components match complexity level — atoms are simple, organisms are complex

---

### API Routes

**Location:** `api/src/services/{domain}/{domain}.routes.ts`

| Domain | Routes File |
|--------|-------------|
| Items | `api/src/services/items/items.routes.ts` |
| Orders | `api/src/services/orders/orders.routes.ts` |
| Shop | `api/src/services/shop/shop.routes.ts` |
| Auth | `api/src/services/auth/auth.routes.ts` |

**Pattern:**
```ts
// api/src/services/items/items.routes.ts
import { Router } from 'itty-router'
const router = Router({ base: '/items' })

router.get('/', withAuthenticatedUser, async (req, env) => {
  // handler
})

export default router
```

---

### Zod Schemas

**Location:** `api/src/services/{domain}/{domain}.schema.ts`

**Pattern:**
```ts
// api/src/services/items/items.schema.ts
import { z } from 'zod'

export const createItemSchema = z.object({
  name: z.string(),
  price: z.number(),
})
```

---

## 🏗️ Architecture Layers

```
┌─────────────────────────────────────────┐
│  apps/                                  │  ← Platform-specific entry points
│  (Next.js pages, Expo screens)          │     - Import from packages/
│                                         │     - No business logic
├─────────────────────────────────────────┤
│  packages/app/                          │  ← Shared application logic
│  ├── dashboard/ (screens)               │     - Cross-platform screens
│  ├── apiHooks/ (React Query)            │     - Hooks, stores, types
│  ├── store/ (Zustand)                   │
│  └── types/ (TypeScript + Zod)          │
├─────────────────────────────────────────┤
│  packages/ui/                           │  ← UI component library
│  ├── atoms/ (Button, Input)             │     - Reusable components
│  ├── molecules/ (Dialog, Sheet)         │     - Tamagui-based
│  ├── organisms/ (Table, Cart)           │
│  └── templates/ (Layouts)               │
├─────────────────────────────────────────┤
│  api/                                   │  ← Backend API
│  ├── services/ (domain routes)          │     - Cloudflare Workers
│  └── infra/ (DB, auth, middleware)      │     - Kysely + D1
└─────────────────────────────────────────┘
```

---

## 📦 Package Imports

| Package | Import Pattern | Example |
|---------|----------------|---------|
| UI atoms | `@shop-diary/ui/atoms/{Component}` | `import { Button } from '@shop-diary/ui/atoms'` |
| UI molecules | `@shop-diary/ui/molecules/{Component}` | `import { SimpleDialog } from '@shop-diary/ui/molecules'` |
| App screens | `@shop-diary/app/{feature}/screen` | `import ItemsScreen from '@shop-diary/app/dashboard/items/screen'` |
| App hooks | `app/apiHooks/use{Entity}` | `import { useItems } from 'app/apiHooks/useItems'` |
| App stores | `app/store/use{Name}Store` | `import { useUserStore } from 'app/store/useUserStore'` |
| App utils | `app/utils/{util}` | `import { fetcherWithToken } from 'app/utils/fetcherWithToken'` |

**NEVER use:**
- ❌ `@ui/...` — Use `@shop-diary/ui/...`
- ❌ `@app/...` — Use `@shop-diary/app/...` or `app/...`
- ❌ `@/...` — Use relative or full package paths

---

## 🔍 Finding Existing Patterns

Before creating a new file:

1. **Check similar features:**
   ```bash
   # Find existing screens
   ls packages/app/dashboard/*/screen.tsx
   
   # Find existing hooks
   ls packages/app/apiHooks/use*.ts
   
   # Find existing routes
   ls api/src/services/*/*.routes.ts
   ```

2. **Read PROJECT_STRUCTURE.md** — You're reading it now! ✅

3. **Check COMMON_PATTERNS.md** — Import patterns, gotchas, error fixes

---

## 📋 Checklist Before Creating Files

- [ ] I checked where similar files exist
- [ ] I'm using the correct directory from the tables above
- [ ] I'm using correct import paths (`@shop-diary/ui`, not `@ui/`)
- [ ] My file is TypeScript (`.ts` or `.tsx`)
- [ ] I'm following existing patterns (checked similar files)

---

**Last updated:** 2026-03-25  
**Maintained by:** ClosedLoop system
