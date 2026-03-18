# Pending Actions (Stacked Order Lifecycle)

## Problem

Shopify can fire lifecycle events (`orders/fulfilled`, `orders/cancelled`, `refunds/create`) before Battle Bus has finished creating the D365 and GPS records for an order. When this happens, the downstream Inngest functions previously returned silently (e.g. `no_d365_order`) and the action was lost — leaving D365/GPS permanently out of sync.

## Solution

A **pending actions queue** stores these out-of-order events in the Supabase `orders.pending_actions` JSONB column. When the order creation flow completes, it emits an `order/lifecycle.ready` event that triggers the `drain-pending-actions` function. This function reads the stored actions, re-emits the original events (with a `fromDrain: true` flag), and clears the queue.

## Architecture

```
Shopify Webhook            Inngest Functions                 Supabase
─────────────────          ──────────────────                ────────
orders/fulfilled  ──────>  process-shopify-fulfillment
                             │
                             ├─ D365 exists? ──> process normally
                             │
                             └─ D365 missing? ──> store in ──> orders.pending_actions
                                                               [{ action: "fulfill", ... }]

orders/created    ──────>  process-shopify-order
                             │
                             └─ on success ──> emit order/lifecycle.ready
                                                   │
                                                   └──> drain-pending-actions
                                                          │
                                                          ├─ read pending_actions
                                                          ├─ re-emit events (fromDrain: true)
                                                          └─ clear pending_actions
```

## Event: `order/lifecycle.ready`

Emitted by:
- `process-shopify-order` — after successful D365 + GPS creation
- `process-backorder` — after successful GPS retry (manual or auto)

Data:
```typescript
{
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyStore: string;
  d365OrderNumber: string;
  warehouseName: string;
  dataAreaId: string;
}
```

## Pending Action Shape

Stored in `orders.pending_actions` (JSONB array):

```typescript
{
  action: "fulfill" | "cancel" | "refund";
  eventName: string;       // Original Inngest event name
  eventData: object;       // Original event.data payload
  createdAt: string;       // ISO timestamp when deferred
}
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Order creation fails permanently | Actions stay queued. Manual rerun of order creation drains on success. |
| Multiple fulfillments/refunds stacked | Each is a separate array entry; drain emits all. |
| Cancel + fulfill both pending | Cancel takes priority; drain skips fulfillment events. |
| Action already processed | Idempotency keys on re-emitted events prevent double-processing. |
| Drain fires but D365 still missing | Functions detect `fromDrain: true` and return `failed` instead of deferring again (no infinite loop). |
| Backorder resolves | `process-backorder` emits `order/lifecycle.ready`, triggering drain. |

## Battle Hub Visibility

Pending actions are visible to operators in Battle Hub:

- `OrderDetailDialog` shows a pending-actions indicator when `orders.pending_actions` is non-empty.
- The indicator summarizes queued action counts (fulfill/cancel/refund) and explains they are drained after order creation succeeds.
- Order details also show live step progress from `order-events-store` so operators can see when drain processing is running/completed.

This prevents "silent queue" behavior and gives clear operational visibility while the order is waiting for D365/GPS creation.

## Hub API

`/api/orders/pending-actions` — service-secret protected

- `GET ?shopifyOrderId=X` — returns `{ actions: PendingAction[] }`
- `PATCH { shopifyOrderId, operation: "append", action }` — adds an action
- `PATCH { shopifyOrderId, operation: "clear" }` — clears all actions

## Database

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pending_actions JSONB DEFAULT '[]'::jsonb;
```

## Files

| File | Role |
|------|------|
| `inngest/src/inngest/events.ts` | `OrderLifecycleReadyEvent` type definition |
| `inngest/src/lib/services/pending-actions.ts` | `storePendingAction`, `getPendingActions`, `clearPendingActions` |
| `inngest/src/inngest/functions/drain-pending-actions.ts` | Drains queued actions on `order/lifecycle.ready` |
| `inngest/src/inngest/functions/process-shopify-fulfillment.ts` | Defers fulfillment when D365 missing |
| `inngest/src/inngest/functions/process-order-cancellation.ts` | Defers cancellation when D365+GPS both missing |
| `inngest/src/inngest/functions/process-refund.ts` | Defers refund when D365 missing |
| `inngest/src/inngest/functions/process-shopify-order.ts` | Emits `order/lifecycle.ready` on success |
| `inngest/src/inngest/functions/process-backorder.ts` | Emits `order/lifecycle.ready` on GPS success |
| `hub/api/orders/pending-actions.ts` | Hub API for reading/writing pending actions |
| `hub/supabase/migrations/002_add_pending_actions.sql` | Schema migration |
| `hub/src/features/orders/components/order-detail-dialog.tsx` | UI indicator for queued pending actions |
