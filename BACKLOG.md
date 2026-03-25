# Shop Diary V3 — Feature Backlog for ClosedLoop

> Last updated: 2026-03-24
> This file is the source of truth for what to feed ClosedLoop as GitHub issues.
> Each ticket maps to one GitHub issue on `jeremiahdingal/shop-diary-v3`.

---

## Why We're Building This

Shop Diary V3 is a **modern, open, cash-first POS** for small shops and cafes.

**The baseline is Loyverse** — a free, widely-used POS system that dominates the small-business market. Our goal: match every Loyverse core feature for free, then exceed it:

| What Loyverse does | What we do better |
|--------------------|------------------|
| Mobile-only (iOS/Android) | Web-first + mobile (Next.js + Expo) |
| Paid add-ons for inventory, staff | All advanced features free |
| No keyboard shortcuts | Full keyboard shortcut support |
| Closed source | Cloudflare-native, self-hostable |
| Card + cash payments | Cash-only simplicity (no gateway overhead) |

**Cash-first model**: No Stripe, no card gateway. The cashier presses **"Confirm Cash Received"** — this is an intentional real-world assumption flag. The operator physically collects cash, then confirms in the app. This keeps the checkout flow simple and removes all payment gateway complexity.

**No tax system**: Excluded by design. Cash-only model for small shops in our target market doesn't require tax calculation in MVP.

---

## Loyverse Reference (for AI agents working on this project)

All agents should use these as visual/API reference when designing features.

### Loyverse API Documentation
Full API reference: https://developer.loyverse.com/docs/

Key endpoints (baseline reference for our API design):
- `GET /v1.0/items` — product catalog with variants, modifiers, taxes
- `GET/POST /v1.0/receipts` — sales receipts (our equivalent: orders)
- `GET /v1.0/inventory_levels` — stock per item per store
- `GET /v1.0/customers` — customer database with loyalty points
- `GET /v1.0/employees` — staff management
- `GET /v1.0/discounts` — discount rules
- `GET /v1.0/taxes` — tax rates (we exclude this)
- `GET /v1.0/payment_types` — payment methods (we use cash only)
- `GET /v1.0/categories` — item categories
- `GET /v1.0/stores` — multi-location stores
- OAuth 2.0: https://cloud.loyverse.com/oauth/authorize

### Loyverse UI / Visual Reference
Use these pages to understand expected UX patterns:

| Feature | Reference URL |
|---------|--------------|
| POS / Cashier | https://loyverse.com/point-of-sale |
| Dashboard / Back Office | https://loyverse.com/back-office |
| Analytics | https://loyverse.com/dashboard |
| Inventory Management | https://loyverse.com/inventory-management |
| Customer Loyalty | https://loyverse.com/loyalty-program |
| Employee Management | https://loyverse.com/employee-management |
| Kitchen Display | https://loyverse.com/kitchen-display-system |

### Key Loyverse UI Patterns to Match or Exceed

**Cashier (POS) screen:**
- Category rail at top (horizontal scroll) — already in v3
- Item grid with image below category rail — already in v3
- Cart panel on right side (or bottom sheet on mobile) — already in v3
- "Charge" / "Send Order" button at cart bottom
- Order total showing subtotal → discount → final total
- Cash confirmation modal: enter tendered amount, show change due
- Receipt preview after payment

**Dashboard screens:**
- Sales summary KPI cards at top (revenue, orders, avg value)
- Sales trend chart (daily/weekly/monthly)
- Top items ranked by sales
- Low stock alert banner when items below threshold
- Customer search + points display at checkout
- Order history table with status filters

---

## Epic Summary & Priority Order

| # | Epic | Priority | Status |
|---|------|----------|--------|
| 1 | Bug Fixes | IMMEDIATE | In progress |
| 2 | Cash Checkout Flow | HIGH | Not started |
| 3 | Analytics & Reporting | HIGH | Not started |
| 7 | Advanced Inventory | HIGH | Not started |
| 4 | Customer Management & Loyalty | MEDIUM | Not started |
| 5 | Discounts & Promotions | MEDIUM | Not started |
| 8 | Orders & Receipts Enhancement | MEDIUM | Not started |
| 9 | Staff & Access Control | MEDIUM | Not started |
| 10 | Shop Settings & Theming | LOW | Not started |
| 11 | Cashier UX Improvements | LOW | Not started |
| 12 | Multi-Location Support | LOW | Not started |

---

## EPIC 1 — Bug Fixes (Priority: IMMEDIATE)

Feed these as individual GitHub issues immediately.

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 1.1 | Fix SimpleDialog controlled-mode open/close | 2 | `packages/ui/src/molecules/SimpleDialog.tsx` — Add `open?: boolean` and `onOpenChange?: (open: boolean) => void` props. When `open` is provided, use controlled mode instead of internal `useState`. Make `triggerElement` optional. **FIXED 2026-03-24** |
| 1.2 | Fix EditItemSheet missing Label import | 1 | `packages/app/dashboard/items/dialogs/EditItemSheet.tsx` line 16 — Add `Label` to tamagui import. **FIXED 2026-03-24** |
| 1.3 | Fix AddCategoryDialog: no query invalidation on success | 2 | `AddCategoryDialog` mutation has no `onSuccess` callback — categories list doesn't refresh. Add `useQueryClient` + `queryClient.invalidateQueries({ queryKey: ['categories'] })` in `onSuccess` |
| 1.4 | Fix categories DELETE using unauthenticated fetcher | 3 | `packages/api/src/services/categories/screen.tsx` — `useSWRMutation` calls bare `fetcher` for DELETE. Replace with `fetcherWithToken` so the auth header is sent |

---

## EPIC 2 — Cash Checkout Flow (Priority: HIGH — makes app usable end-to-end)

This epic completes the cashier flow. Currently orders can be built but not completed.
Feed as individual GitHub issues after Epic 1.

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 2.1 | Cashier: Order total summary panel | 4 | Add a totals section at the bottom of the cart showing: subtotal, any discounts applied, and final total. Matches Loyverse's pre-checkout total display |
| 2.2 | Cashier: Cash confirmation modal with change calculator | 5 | After "Send Order" / "Charge", show a modal where cashier enters amount tendered. Calculate and display change due. "Confirm Cash Received" button submits the order. This is the real-world assumption flag — cashier physically collects cash before pressing confirm |
| 2.3 | Cashier: Order completed / new sale screen | 4 | After confirming cash received, show a success screen with order summary. "New Sale" button clears cart and returns to POS. No receipt email — just on-screen summary |
| 2.4 | API: PATCH /orders/:id/complete | 3 | Endpoint to mark order as completed. Sets `status = 'completed'`, records `payment_method = 'cash'`, `paid_at` timestamp. Deducts inventory for each item in the order |
| 2.5 | Cashier: Quick quantity +/- buttons in cart | 3 | Add + and - icon buttons on each cart line item. Pressing + increments qty, - decrements (removes line at 0). No need to open item detail sheet |
| 2.6 | Cashier: Remove item from cart | 2 | Add an X / trash icon button on each cart line to remove it entirely. Currently no way to remove without re-opening item detail |
| 2.7 | Cashier: Order note field | 3 | Add a "Note" text input field at the bottom of the cart (above total). Optional free text sent with order as `orderNote`. Shown on order detail in dashboard |

---

## EPIC 3 — Dashboard Analytics & Reporting (Priority: HIGH)

Loyverse ref: https://loyverse.com/dashboard
Loyverse API ref: https://developer.loyverse.com/docs/#tag/Sales-Summary

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 3.1 | API: GET /reports/summary | 4 | Returns: totalRevenue, orderCount, avgOrderValue, for ?period=today\|week\|month\|year. Queries completed orders only. Groups by period using created_at |
| 3.2 | API: GET /reports/items | 4 | Returns items ranked by qty_sold and revenue for a date range. Joins orders → order_items → items. Supports ?period= query param |
| 3.3 | API: GET /reports/categories | 3 | Sales volume and revenue grouped by categoryId. Joins same tables as report/items but groups by category |
| 3.4 | Frontend: Analytics screen with KPI cards | 5 | New dashboard screen at /analytics. Shows 3 KPI cards: Today's Revenue, Order Count, Avg Order Value. Period selector (Today / Week / Month). Add to DashboardLayout nav |
| 3.5 | Frontend: Sales trend chart | 6 | Line chart on Analytics screen. X-axis: days/weeks/months. Y-axis: revenue. Uses a lightweight chart library (recharts or victory-native). Toggle between periods |
| 3.6 | Frontend: Top items table on analytics screen | 4 | Sortable table below chart. Columns: Item image, Name, Qty Sold, Revenue. Shows top 10 by default |
| 3.7 | Frontend: Export analytics to CSV | 4 | "Export CSV" button on Analytics screen. Fetches report data and triggers browser download of CSV file with headers |

---

## EPIC 4 — Customer Management & Loyalty (Priority: MEDIUM)

Loyverse ref: https://loyverse.com/loyalty-program
Loyverse API ref: https://developer.loyverse.com/docs/#tag/Customers

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 4.1 | API: CRUD /customers | 3 | CRUD scaffold. Fields: customerId (ULID), shopId, firstName, lastName, email, phone, address, notes, loyaltyPoints (int default 0), createdAt. Routes: GET/POST /customers, GET/PATCH/DELETE /customers/:id |
| 4.2 | API: GET /customers/:id/history | 3 | Returns paginated list of orders linked to this customer (by customerId on orders table). Includes orderId, total, itemCount, createdAt |
| 4.3 | API: Loyalty points accrual and redemption | 6 | Add pointsPerCurrency setting to shop (e.g. 1 point per $1). When order is completed: add earned points to customer. Order creation accepts `redeemPoints` (int) which deducts from total and from customer balance. |
| 4.4 | Frontend: Customers management screen | 5 | New dashboard screen at /customers. Table with search by name/email/phone. Columns: Name, Email, Phone, Points Balance, Last Visit. Add/Edit/Delete actions. Add to nav |
| 4.5 | Frontend: Customer detail view | 5 | Customer detail page at /customers/:id. Shows editable info, points balance, and purchase history list |
| 4.6 | Cashier: Attach customer to order | 5 | Search bar in cashier (e.g. in cart panel header). Type name or phone to find customer. Selecting links customerId to current cart/order |
| 4.7 | Cashier: Show loyalty points and allow redemption | 5 | When customer is attached to order, show their points balance. Allow cashier to toggle "Redeem X points" which applies a discount equal to points value |

---

## EPIC 5 — Discounts & Promotions (Priority: MEDIUM)

Loyverse ref: https://developer.loyverse.com/docs/#tag/Discounts

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 5.1 | API: CRUD /discounts | 3 | CRUD scaffold. Fields: discountId, shopId, name, type (fixed\|percent), value (number), scope (item\|receipt), active (boolean). Routes: GET/POST /discounts, GET/PATCH/DELETE /discounts/:id |
| 5.2 | API: Apply discount to order on creation | 4 | POST /orders/create accepts optional `discountId` (receipt-level) and per-item `discountId`. Server computes discounted total. Stores discountAmount on order record |
| 5.3 | Frontend: Discounts management screen | 4 | New dashboard screen at /discounts. Table with columns: Name, Type, Value, Scope, Active toggle. Add/Edit/Delete |
| 5.4 | Cashier: Apply receipt-level discount at checkout | 4 | "% Discount" button in cart. Opens modal to search saved discounts or enter a quick one-off percentage. Applied to cart total |
| 5.5 | Cashier: Apply item-level discount in cart | 5 | Context menu (long press / right click) on a cart line item. Option to apply a fixed or % discount to that line only |

---

## ~~EPIC 6 — Tax Management~~ (EXCLUDED — cash-only, no tax needed)

---

## EPIC 7 — Advanced Inventory (Priority: HIGH — free feature vs Loyverse paid add-on)

Loyverse ref: https://loyverse.com/inventory-management
Loyverse API ref: https://developer.loyverse.com/docs/#tag/Inventory

This is a key differentiator: Loyverse charges ~£20/month for this. We provide it free.

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 7.1 | API: POST /inventory/adjustments | 4 | Endpoint for manual stock adjustment. Body: `{ itemId, delta, reason }`. Reason options: 'recount', 'damaged', 'restock', 'other'. Creates InventoryAdjustments record. Updates item's itemBaseCount |
| 7.2 | API: GET /inventory/adjustments | 3 | Returns history of adjustments filtered by ?itemId= or ?shopId=. Sorted by createdAt desc. Returns: adjustmentId, itemId, oldQty, newQty, delta, reason, createdAt |
| 7.3 | API: Low stock threshold and alert endpoint | 4 | Add `lowStockThreshold` (int, default null) to items table. GET /inventory/low-stock returns all items where itemBaseCount <= lowStockThreshold. Used by dashboard banner |
| 7.4 | API: CRUD /suppliers | 3 | CRUD scaffold. Fields: supplierId, shopId, name, contactName, email, phone, address, notes. Routes: GET/POST /suppliers, GET/PATCH/DELETE /suppliers/:id |
| 7.5 | API: CRUD /purchase-orders | 6 | CRUD + status flow. Fields: poId, shopId, supplierId, status (draft\|sent\|received), lineItems ([{itemId, quantity, unitCost}]), notes, createdAt. When status changes to 'received': add line quantities to item inventory and create InventoryAdjustments records with reason='restock' |
| 7.6 | Frontend: Inventory screen | 6 | New dashboard screen at /inventory. Table of all items with: image, name, current stock, low stock threshold (editable inline), last adjusted date. "Adjust" button on each row opens adjustment modal. Shows adjustment history in expandable row |
| 7.7 | Frontend: Low stock alert banner in dashboard | 3 | Check GET /inventory/low-stock on dashboard load. If any items returned, show a yellow banner in DashboardLayout sidebar/header: "X items low on stock". Click navigates to /inventory with low-stock filter active |
| 7.8 | Frontend: Suppliers management screen | 4 | New dashboard screen at /suppliers. Table: name, contact, email, phone, open PO count. Add/Edit/Delete. Add to nav under inventory section |
| 7.9 | Frontend: Purchase Orders screen | 7 | New dashboard screen at /purchase-orders. List view with status badges. "Create PO" form: select supplier, add line items (item + qty + unit cost). Status flow: Draft → Sent → Received. Marking received triggers inventory update |

---

## EPIC 8 — Orders & Receipts Enhancement (Priority: MEDIUM)

Loyverse API ref: https://developer.loyverse.com/docs/#tag/Receipts
Loyverse API ref: https://developer.loyverse.com/docs/#tag/Orders

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 8.1 | API: Open ticket (hold order) support | 5 | Orders can be created with `status = 'open'` and saved without completing payment. GET /orders?status=open returns held tickets. PATCH /orders/:id can move from open → active |
| 8.2 | API: POST /orders/:id/refund | 5 | Partial or full refund. Body: `{ items: [{itemId, quantity}] }` (empty = full refund). Creates a refund record linked to original order. Restores inventory for refunded items. Sets order status to 'refunded' |
| 8.3 | API: GET /receipts/:orderId | 4 | Returns structured receipt payload: shopName, shopLogo, orderDate, lineItems (name, qty, price, subtotal), discountAmount, total, paymentMethod, cashierName |
| 8.4 | Frontend: Orders screen with status filters | 5 | Existing /orders screen — add status filter tabs (All / Open / Completed / Refunded). Add date range picker. Order rows link to detail view |
| 8.5 | Frontend: Order detail view | 5 | New page at /orders/:id. Shows: line items table, customer info, totals, payment info, timestamp, cashier name. "Refund" button for completed orders |
| 8.6 | Frontend: Refund flow on order detail | 5 | "Refund" button opens a modal. Select full refund or check individual items. Confirm → calls refund API → refreshes order status |
| 8.7 | Cashier: Open tickets list and hold/resume | 6 | "Hold" button in cashier saves current cart as open order. "Open Tickets" tab shows list of held orders. Tapping one loads it back into the cart |
| 8.8 | Cashier: Receipt screen after cash confirmation | 5 | After confirming cash, show a receipt-style view. Includes shop name/logo, item list, total paid, change given. "Print" triggers window.print(). "New Sale" clears and returns to POS |

---

## EPIC 9 — Staff & Access Control (Priority: MEDIUM — free vs Loyverse paid add-on)

Loyverse ref: https://loyverse.com/employee-management
Loyverse API ref: https://developer.loyverse.com/docs/#tag/Employees

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 9.1 | API: Role-based access control middleware | 6 | User roles: admin, manager, cashier. Add role field to users table. Add `requireRole(role)` middleware. Dashboard management routes (items, categories, staff) require admin/manager. Cashier routes allow all roles |
| 9.2 | API: CRUD /staff with invite flow | 4 | Admin-only. POST /staff/invite sends invite (or creates user with temp password). PATCH /staff/:id for role changes. DELETE /staff/:id deactivates (sets active=false, does not delete) |
| 9.3 | API: Time clock endpoints | 5 | POST /timeclock/in — creates shift record with userId, clockInAt. POST /timeclock/out/:shiftId — sets clockOutAt, calculates hoursWorked. GET /timeclock?userId=&startDate=&endDate= returns shift history |
| 9.4 | API: GET /reports/staff | 4 | Returns per-employee: orderCount, totalRevenue, avgOrderValue for a date range. Joins orders where cashierId = userId |
| 9.5 | Frontend: Staff management screen | 5 | New dashboard screen at /staff. Table: name, role badge, email, status (active/inactive). Invite button. Edit role. Deactivate. Admin-only view |
| 9.6 | Frontend: Staff performance report | 4 | Table on analytics/staff tab. Columns: name, orders handled, total revenue, avg order value. Filterable by date range |
| 9.7 | Cashier: Employee PIN login | 6 | Cashier app landing: show PIN pad instead of email/password form. Each staff member has a 4-digit PIN. PIN lookup returns JWT for that employee. Normal auth for dashboard remains email/password |

---

## EPIC 10 — Shop Settings & Theming (Priority: LOW)

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 10.1 | Frontend: Dark/light mode toggle in My Shop | 4 | Toggle switch in /myshop settings. Saves darkMode boolean to shop record via PATCH /shops/myshop. On toggle: updates Tamagui colorScheme prop in _app.tsx |
| 10.2 | Frontend: Accent color picker | 5 | Color picker in /myshop settings. Saves accentColor hex to shop record. On change: updates Tamagui theme tokens (currently hardcoded purple). Should cascade through buttons, active states, highlights |
| 10.3 | Frontend: Shop logo in cashier header | 3 | In cashier top bar: show shop logo (TImage from Tamagui) beside shop name. Fetch from useShop() hook. Falls back to shop name initials if no logo |
| 10.4 | API: Extend PATCH /shops/myshop with theme fields | 3 | Add `darkMode` (boolean) and `accentColor` (varchar 7) to shops table schema. Add to PATCH handler and Zod validation |
| 10.5 | Frontend: Receipt footer customization | 4 | In /myshop settings: add fields for receiptWebsite (URL), receiptThankYou (text), receiptSocial (text). Shown at bottom of receipt screen and print view |

---

## EPIC 11 — Cashier UX Improvements (Exceed Loyverse)

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 11.1 | Cashier: Search/filter items by name | 4 | Add text input above item grid. Filters displayed items in real-time using local state (no API call). Clears when category changes. Matches Loyverse's item search |
| 11.2 | Cashier: Barcode scan input | 5 | Add `barcode` (varchar) field to items table and Add/Edit Item forms. In cashier: hidden text input auto-captures barcode scanner input (fast keystroke sequence ending in Enter). Looks up item by barcode, adds to cart |
| 11.3 | Cashier: Keyboard shortcuts | 4 | Implement keyboard shortcuts in cashier web app: `/` focuses search, `Escape` clears search/closes modals, `Enter` in cash modal confirms payment, `n` starts new sale after completion. Show shortcut hints in UI |
| 11.4 | Cashier: Offline mode with local sync queue | 9 | On cashier load: cache items and categories in localStorage/IndexedDB. On order creation when offline: queue order locally. When connection restored: flush queue to API. Show offline badge in UI. High complexity — requires service worker or background sync |

---

## EPIC 12 — Multi-Location Support (Priority: LOW)

Loyverse ref: https://developer.loyverse.com/docs/#tag/Stores

| # | Issue Title | Complexity | Description |
|---|------------|-----------|-------------|
| 12.1 | API: CRUD /locations | 6 | Multiple stores per account. Fields: locationId, companyId, name, address, phone. All items, inventory, and orders get locationId. Auth middleware injects activeLocationId from JWT or header |
| 12.2 | API: Inventory scoped per location | 6 | Inventory table gains locationId. All inventory queries filter by locationId. Item creation seeds inventory record per location |
| 12.3 | API: POST /inventory/transfer | 6 | Transfer stock between locations. Body: `{ fromLocationId, toLocationId, itemId, quantity }`. Decrements source, increments destination, creates two adjustment records |
| 12.4 | Frontend: Location switcher in dashboard nav | 5 | Dropdown in DashboardLayout header. Shows all locations for current account. Switching updates active location in Zustand store and refetches all queries |
| 12.5 | Frontend: Per-location analytics | 5 | Analytics screen gains location filter. Can compare two locations side by side or view aggregate across all |

---

## How to Feed These to ClosedLoop

1. Create a GitHub issue on `jeremiahdingal/shop-diary-v3`
2. Use the **Issue Title** from the table as the issue title
3. Paste the **Description** as the issue body, plus add relevant context from MEMORY.md
4. Assign to the ClosedLoop agent in Paperclip
5. ClosedLoop will score complexity, route to the right pipeline, and ship a PR

For CRUD scaffold tickets (complexity 3, marked "CRUD scaffold"), ClosedLoop's scaffold engine will generate the full service with zero LLM calls. These are fast.

For complex tickets (complexity 6+), ClosedLoop may call the remote architect (GLM-5) to decompose before building.
