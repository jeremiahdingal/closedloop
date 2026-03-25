# Shop Diary V3 — Common Patterns & Gotchas

> **CRITICAL:** Read this before writing any code. These are the most common mistakes that cause build failures.

---

## 🚫 Most Common Build Errors (AVOID THESE)

### 1. Wrong Import Paths (40% of failures)

**❌ WRONG:**
```ts
import { Button } from '@ui/atoms/Button'
import { useUser } from '@app/hooks/useUser'
import { fetcher } from '@/utils/fetcher'
```

**✅ CORRECT:**
```ts
import { Button } from '@shop-diary/ui/atoms/Button'
import { useUser } from '@shop-diary/app/hooks/useUser'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'
```

**Rule:** Always use full package names: `@shop-diary/ui` and `@shop-diary/app`  
**NEVER use:** `@ui/`, `@app/`, or `@/`

---

### 2. Hallucinated Packages (25% of failures)

**❌ DON'T USE these packages (not in package.json):**
- `ky` — Use native `fetch` or `fetcherWithToken` from `app/utils/fetcherWithToken`
- `axios` — Use native `fetch`
- `lodash` — Use native JS array methods or `@radix-ui` utilities
- `styled-components`, `emotion` — Use React Native `StyleSheet.create()`
- `div`, `span`, `button` — Use React Native `View`, `Text`, `Pressable`

**✅ DO USE these (already installed):**
- HTTP: `fetch`, `fetcherWithToken` (from `app/utils/fetcherWithToken`)
- Styling: `StyleSheet.create()` + `useTheme()` hook
- Icons: `@tamagui/lucide-icons`
- UI Components: `@shop-diary/ui` (all Tamagui-based)

---

### 3. Wrong Function Signatures (15% of failures)

**❌ WRONG:**
```ts
// fetcherWithToken takes object, not separate args
fetcherWithToken(url, { method: 'GET' })

// Kysely uses sql template tag, not raw strings
db.updateTable('items').set({ stock: 'stock - 1' })
```

**✅ CORRECT:**
```ts
// fetcherWithToken takes single object argument
fetcherWithToken({ url, method: 'GET' })

// Kysely uses sql template tag for expressions
db.updateTable('items').set({ stock: sql`stock - 1` })
```

**Rule:** Check existing files for function signatures before calling

---

### 4. Wrong File Placement (10% of failures)

| File Type | Correct Location | Example |
|-----------|-----------------|---------|
| Dashboard screens | `packages/app/dashboard/{feature}/screen.tsx` | `packages/app/dashboard/items/screen.tsx` |
| Cashier screens | `packages/app/cashier/{feature}/screen.tsx` | `packages/app/cashier/checkout/screen.tsx` |
| API hooks | `packages/app/apiHooks/use{Entity}.ts` | `packages/app/apiHooks/useItems.ts` |
| Zustand stores | `packages/app/store/{name}.ts` | `packages/app/store/useUserStore.ts` |
| UI atoms | `packages/ui/src/atoms/{Component}.tsx` | `packages/ui/src/atoms/Button.tsx` |
| UI molecules | `packages/ui/src/molecules/{Component}.tsx` | `packages/ui/src/molecules/SimpleDialog.tsx` |
| UI organisms | `packages/ui/src/organisms/{Component}.tsx` | `packages/ui/src/organisms/AdvancedTable.tsx` |
| UI templates | `packages/ui/src/templates/{Layout}.tsx` | `packages/ui/src/templates/DashboardLayout.tsx` |
| API routes | `api/src/services/{domain}/{domain}.routes.ts` | `api/src/services/items/items.routes.ts` |
| Zod schemas | `api/src/services/{domain}/{domain}.schema.ts` | `api/src/services/items/items.schema.ts` |
| Next.js pages (dashboard) | `apps/dashboard-web/pages/{feature}.tsx` | `apps/dashboard-web/pages/items.tsx` |
| Next.js pages (cashier) | `apps/cashier-web/pages/{feature}.tsx` | `apps/cashier-web/pages/checkout.tsx` |

**Rule:** Screens go in `packages/app/`, thin page wrappers in `apps/*/pages/`

---

### 5. HTML Instead of React Native (5% of failures)

**❌ WRONG (web React):**
```tsx
<div className="container">
  <span>Hello</span>
  <button onClick={handleClick}>Click</button>
</div>
```

**✅ CORRECT (React Native):**
```tsx
import { StyleSheet } from 'react-native'
import { useTheme } from '@shop-diary/ui/src/theme'

const theme = useTheme()

<View style={styles.container}>
  <Text style={{ color: theme.color11 }}>Hello</Text>
  <Pressable onPress={handleClick}>
    <Text>Click</Text>
  </Pressable>
</View>

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
})
```

**Rule:** This is cross-platform (web + mobile). Use React Native components.

---

## 📐 Architecture Patterns

### Component Structure
```tsx
// packages/app/dashboard/items/screen.tsx
import { useState } from 'react'
import { StyleSheet } from 'react-native'
import { Box, Text, Button } from '@shop-diary/ui/atoms'
import { useTheme } from '@shop-diary/ui/src/theme'
import { DashboardLayout } from '@shop-diary/ui/src/templates'
import { useItems } from 'app/apiHooks/useItems'

export default function ItemsScreen() {
  const theme = useTheme()
  const { items, isLoading } = useItems()
  const [selected, setSelected] = useState<string | null>(null)

  if (isLoading) return <Text>Loading...</Text>

  return (
    <DashboardLayout title="Items">
      <Box padding="$4">
        {items.map(item => (
          <Text key={item.id} color={theme.color11}>
            {item.name}
          </Text>
        ))}
      </Box>
    </DashboardLayout>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
})
```

### API Route Structure
```ts
// api/src/services/items/items.routes.ts
import { Router } from 'itty-router'
import { withAuthenticatedUser } from '../../infra/auth'
import { getDb } from '../../infra/db'
import { sql } from 'kysely'
import { z } from 'zod'

const router = Router({ base: '/items' })

// GET /items
router.get('/', withAuthenticatedUser, async (req, env) => {
  const db = getDb(env)
  const items = await db.selectFrom('items').selectAll().execute()
  return Response.json(items)
})

// POST /items
router.post('/', withAuthenticatedUser, async (req, env) => {
  const db = getDb(env)
  const body = await req.json()
  
  // Validate with Zod schema
  const schema = z.object({
    name: z.string(),
    price: z.number(),
  })
  const validated = schema.parse(body)
  
  const item = await db.insertInto('items').values(validated).returningAll().executeTakeFirst()
  return Response.json(item)
})

export default router
```

### API Hook Structure
```ts
// packages/app/apiHooks/useItems.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'

export interface Item {
  id: string
  name: string
  price: number
}

export function useItems() {
  return useQuery<Item[]>({
    queryKey: ['items'],
    queryFn: () => fetcherWithToken({ url: '/api/items' }),
  })
}

export function useCreateItem() {
  const queryClient = useQueryClient()
  
  return useMutation({
    mutationFn: (data: Partial<Item>) => 
      fetcherWithToken({ url: '/api/items', method: 'POST', body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] })
    },
  })
}
```

---

## 🛠️ How to Fix Build Errors

### When you see "Module not found"

1. **Check the import path** — Is it `@shop-diary/ui` not `@ui/`?
2. **Check the package exists** — Look in `package.json`
3. **Check similar files** — How do other files import the same thing?

### When you see TypeScript errors

1. **TS2307 (Cannot find module)** — Import path is wrong
2. **TS2339 (Property does not exist)** — Check interface definition
3. **TS2322 (Not assignable)** — Type mismatch, check expected type
4. **TS7006 (Implicit any)** — Add explicit type annotation

### When unsure about patterns

1. **Search existing files** — `grep -r "import.*from '@shop-diary"` 
2. **Check PROJECT_STRUCTURE.md** — File placement rules
3. **Read this document** — Common patterns are here

---

## 📋 Quick Reference

### Import Cheatsheet
```ts
// UI components
import { Button, Input } from '@shop-diary/ui/atoms'
import { SimpleDialog } from '@shop-diary/ui/molecules'
import { DashboardLayout } from '@shop-diary/ui/templates'

// App logic
import { useItems } from 'app/apiHooks/useItems'
import { useUserStore } from 'app/store/useUserStore'
import { fetcherWithToken } from 'app/utils/fetcherWithToken'

// Tamagui
import { YStack, XStack, Paragraph } from 'tamagui'
import { useTheme } from '@shop-diary/ui/src/theme'

// Icons
import { Search, Plus, Trash } from '@tamagui/lucide-icons'

// React Native
import { View, Text, Pressable, StyleSheet } from 'react-native'
```

### Build Command
```bash
npx turbo run build --filter=@shop-diary/ui --filter=@shop-diary/app
```

### Key Directories
```
packages/app/          — Shared screens, hooks, stores, types
packages/ui/           — Shared UI components
apps/dashboard-web/    — Dashboard web app (Next.js)
apps/cashier-web/      — Cashier web app (Next.js)
api/                   — Cloudflare Workers API
```

---

## ⚠️ Red Flags (Stop and Check)

If you're about to write:

- [ ] `import X from '@ui/...'` → **STOP** — Use `@shop-diary/ui`
- [ ] `import X from '@/...'` → **STOP** — Use relative or `app/` path
- [ ] `import ky from 'ky'` → **STOP** — Use `fetcherWithToken`
- [ ] `<div>...</div>` → **STOP** — Use `<View>...</View>`
- [ ] `className="..."` → **STOP** — Use `style={styles.foo}`
- [ ] Creating file in `apps/` directly → **STOP** — Screen goes in `packages/app/`

---

**Last updated:** 2026-03-25  
**Maintained by:** ClosedLoop system (auto-updated from reflection memory)
