# Battle Hub POC Roadmap

> **Mission**: Build an enterprise-grade order management hub that eliminates every pain point exposed in the Spock Store era.

## Executive Summary

This document outlines the complete feature set required to transform Battle Hub into a world-class operations dashboard that will:

- **Eliminate manual interventions** (no more "can we rerun the sync?" Slack messages)
- **Provide real-time visibility** (no more "please investigate this order")
- **Automate recovery** (no more "114 orders manually reran")
- **Enable self-service** (Ops, Finance, CS can solve problems without engineering)

---

## Pain Points Addressed

| Slack Quote | Date | Battle Hub Solution |
|-------------|------|---------------------|
| "4000 orders still not fulfilled... some go as far back as 1 Dec" | Dec 18 | Bulk Operations Center + Real-time Alerts |
| "2400 orders fulfilled but not synced to Shopify. Can we rerun?" | Dec 23 | Fulfillment Sync Monitor + Auto-retry |
| "Order created 18 Dec was just synced to D365 on 2 Jan" | Jan 3 | Order Lifecycle Tracker |
| "task reran for 114 orders due to insufficient inventory" | Jan 2 | OOS Auto-Retry Queue |
| "Pls help replenish these SKUs" | Multiple | Inventory Health Dashboard |
| "Can you check this order?" | Multiple | CS Order Lookup |

---

## Feature Specifications

### 1. Inventory Health Dashboard

**Priority**: 🔴 Critical  
**Effort**: Medium  
**Stakeholders**: Ops, Management

#### Purpose
Proactive inventory monitoring across all systems (Shopify, D365, GPS, Stord, Extensiv) with automated alerts before stockouts cause order failures.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  INVENTORY HEALTH DASHBOARD                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  🔴 CRITICAL (< 10)     🟡 LOW (10-50)     🟢 HEALTHY (50+)                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ SKU              │ Shopify │ D365  │ GPS   │ Stord │ Status │ Action│   │
│  ├──────────────────┼─────────┼───────┼───────┼───────┼────────┼───────┤   │
│  │ IM8-FG-000053    │    45   │   42  │   0   │  --   │   🔴   │ [Sync]│   │
│  │ IM8-FG-000030    │   120   │  118  │  115  │  --   │   🟢   │       │   │
│  │ IM8-FG-000048    │    28   │   25  │   22  │  --   │   🟡   │ [Sync]│   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Bulk Sync Selected]  [Export Report]  [Set Alert Thresholds]             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model

```typescript
interface InventoryItem {
  sku: string;
  productName: string;
  quantities: {
    shopify: number;
    dynamics: number;
    gps: number | null;
    stord: number | null;
    extensiv: number | null;
  };
  thresholds: {
    critical: number;  // default: 10
    low: number;       // default: 50
  };
  lastSynced: Date;
  discrepancies: InventoryDiscrepancy[];
}

interface InventoryDiscrepancy {
  sourceSystem: string;
  targetSystem: string;
  difference: number;
  detectedAt: Date;
  resolvedAt: Date | null;
}
```

#### Inngest Functions

| Function | Event | Description |
|----------|-------|-------------|
| `inventory/check.scheduled` | Cron: `0 * * * *` (hourly) | Poll all warehouses, compare quantities |
| `inventory/alert.low-stock` | `inventory/threshold.breached` | Send Slack notification to #tech-ops |
| `inventory/sync.requested` | `inventory/sync.manual` | Sync specific SKU across systems |
| `inventory/discrepancy.detected` | `inventory/mismatch.found` | Log, alert, auto-reconcile if configured |

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory` | List all inventory with filters |
| GET | `/api/inventory/:sku` | Get specific SKU details |
| POST | `/api/inventory/sync` | Trigger manual sync for SKU(s) |
| POST | `/api/inventory/bulk-sync` | Sync all selected SKUs |
| PUT | `/api/inventory/thresholds` | Update alert thresholds |

#### Files to Create/Modify

```
src/
├── features/
│   └── inventory/
│       ├── index.tsx                    # Main inventory page (exists, enhance)
│       ├── components/
│       │   ├── inventory-table.tsx      # Inventory data table (exists, enhance)
│       │   ├── inventory-filters.tsx    # Filter controls (NEW)
│       │   ├── inventory-stats.tsx      # Summary stats cards (NEW)
│       │   └── threshold-dialog.tsx     # Configure thresholds (NEW)
│       └── hooks/
│           └── use-inventory.ts         # Data fetching hook (NEW)
├── app/
│   └── api/
│       └── inventory/
│           ├── route.ts                 # GET /api/inventory (NEW)
│           ├── [sku]/
│           │   └── route.ts             # GET /api/inventory/:sku (NEW)
│           └── actions/
│               ├── sync/
│               │   └── route.ts         # POST /api/inventory/sync (NEW)
│               └── bulk-sync/
│                   └── route.ts         # POST /api/inventory/bulk-sync (enhance)
├── inngest/
│   └── functions/
│       ├── inventory-check.ts           # Scheduled inventory check (NEW)
│       ├── inventory-alert.ts           # Low stock alerting (NEW)
│       └── inventory-sync.ts            # Manual sync handler (NEW)
└── lib/
    └── services/
        └── inventory.ts                 # Inventory service (exists, enhance)
```

---

### 2. Order Lifecycle Tracker

**Priority**: 🔴 Critical  
**Effort**: Medium  
**Stakeholders**: Ops, CS, Management

#### Purpose
Visual representation of every order's journey through all systems with real-time status updates and stuck order detection.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ORDER LIFECYCLE: IM8-521173                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │
│  │ Shopify │───▶│  D365   │───▶│   GPS   │───▶│Fulfilled│───▶│  Synced │   │
│  │  Paid   │    │   SO    │    │  Order  │    │         │    │         │   │
│  └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘   │
│       │              │              │              │              │        │
│      ✅             ✅             ✅             🔄             ⏳       │
│    0.2s           1.1s           2.3s          WAITING       PENDING      │
│                                                                             │
│  TIMELINE:                                                                  │
│  ├─ 2026-01-08 12:01:03  Shopify webhook received                          │
│  ├─ 2026-01-08 12:01:03  Inngest event triggered                           │
│  ├─ 2026-01-08 12:01:04  D365 sales order created (H001-SO-152891)         │
│  ├─ 2026-01-08 12:01:06  GPS outbound order created                        │
│  └─ 2026-01-08 12:01:06  ⏳ Waiting for GPS fulfillment callback...        │
│                                                                             │
│  [Retry Step]  [Manual Fulfill]  [View Logs]  [Contact Support]            │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model

```typescript
interface OrderLifecycle {
  orderId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  currentStage: OrderStage;
  stages: OrderStageRecord[];
  alerts: OrderAlert[];
  createdAt: Date;
  updatedAt: Date;
}

type OrderStage = 
  | 'webhook_received'
  | 'inngest_triggered'
  | 'd365_created'
  | 'warehouse_sent'      // GPS, Stord, or Extensiv
  | 'warehouse_fulfilled'
  | 'd365_fulfilled'
  | 'shopify_fulfilled'
  | 'completed'
  | 'failed'
  | 'oos_queued';

interface OrderStageRecord {
  stage: OrderStage;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, any>;
  error: string | null;
}

interface OrderAlert {
  type: 'stuck' | 'failed' | 'oos' | 'discrepancy';
  message: string;
  severity: 'info' | 'warning' | 'critical';
  createdAt: Date;
  acknowledgedAt: Date | null;
}
```

#### Inngest Functions

| Function | Event | Description |
|----------|-------|-------------|
| `order/lifecycle.track` | All order events | Update lifecycle state after each step |
| `order/stale.check` | Cron: `*/15 * * * *` | Find orders stuck > threshold |
| `order/stale.alert` | `order/stale.detected` | Slack alert with order details |

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders/:id/lifecycle` | Get full lifecycle for order |
| GET | `/api/orders/stuck` | List all stuck orders |
| POST | `/api/orders/:id/retry` | Retry failed step |

#### Files to Create/Modify

```
src/
├── features/
│   └── orders/
│       ├── components/
│       │   ├── order-lifecycle.tsx      # Visual pipeline (NEW)
│       │   ├── order-timeline.tsx       # Event timeline (NEW)
│       │   └── stage-indicator.tsx      # Individual stage status (NEW)
│       └── hooks/
│           └── use-order-lifecycle.ts   # Lifecycle data hook (NEW)
├── app/
│   └── api/
│       └── orders/
│           ├── [id]/
│           │   ├── lifecycle/
│           │   │   └── route.ts         # GET lifecycle (NEW)
│           │   └── retry/
│           │       └── route.ts         # POST retry (NEW)
│           └── stuck/
│               └── route.ts             # GET stuck orders (NEW)
├── inngest/
│   └── functions/
│       ├── order-lifecycle-track.ts     # Track lifecycle updates (NEW)
│       └── order-stale-check.ts         # Cron for stuck orders (NEW)
└── lib/
    └── services/
        └── order-lifecycle.ts           # Lifecycle service (NEW)
```

---

### 3. Bulk Operations Center

**Priority**: 🔴 Critical  
**Effort**: Medium  
**Stakeholders**: Ops

#### Purpose
Enable mass retry/resync operations with progress tracking, eliminating the need for manual task replays.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BULK OPERATIONS CENTER                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  QUICK ACTIONS:                                                            │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐            │
│  │  Retry Failed    │ │  Resync to D365  │ │ Resync to Shopify│            │
│  │     Orders       │ │                  │ │                  │            │
│  │    [23 orders]   │ │   [156 orders]   │ │    [89 orders]   │            │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘            │
│                                                                             │
│  CUSTOM BULK ACTION:                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Filter: [Date Range ▼] [Status ▼] [Warehouse ▼] [SKU ▼]            │   │
│  │                                                                     │   │
│  │ Found: 1,847 orders                                                 │   │
│  │                                                                     │   │
│  │ Action: [Retry All ▼]  [Preview] [Execute]                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ACTIVE OPERATIONS:                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Operation          │ Progress        │ Started    │ Status         │   │
│  ├────────────────────┼─────────────────┼────────────┼────────────────┤   │
│  │ Retry GPS UK OOS   │ ████████░░ 80%  │ 5 min ago  │ In Progress    │   │
│  │ Resync to Shopify  │ ██████████ 100% │ 1 hour ago │ ✅ Complete    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model

```typescript
interface BulkOperation {
  id: string;
  type: 'retry' | 'resync_d365' | 'resync_shopify' | 'resync_warehouse';
  filters: BulkOperationFilters;
  orderIds: string[];
  totalCount: number;
  processedCount: number;
  successCount: number;
  failedCount: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  startedAt: Date;
  completedAt: Date | null;
  startedBy: string;
  results: BulkOperationResult[];
}

interface BulkOperationFilters {
  dateRange?: { start: Date; end: Date };
  status?: string[];
  warehouse?: string[];
  sku?: string[];
  country?: string[];
}

interface BulkOperationResult {
  orderId: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  processedAt: Date;
}
```

#### Inngest Functions

| Function | Event | Description |
|----------|-------|-------------|
| `bulk/operation.execute` | `bulk/operation.started` | Fan-out to individual order retries |
| `bulk/operation.process-order` | `bulk/order.retry` | Process single order in bulk op |
| `bulk/operation.complete` | All orders done | Send Slack summary |

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bulk-operations` | List all bulk operations |
| GET | `/api/bulk-operations/:id` | Get operation details + progress |
| POST | `/api/bulk-operations` | Start new bulk operation |
| POST | `/api/bulk-operations/:id/cancel` | Cancel running operation |
| GET | `/api/bulk-operations/preview` | Preview orders matching filters |

#### Files to Create/Modify

```
src/
├── features/
│   └── bulk-operations/
│       ├── index.tsx                    # Main bulk ops page (NEW)
│       ├── components/
│       │   ├── quick-actions.tsx        # Quick action cards (NEW)
│       │   ├── filter-builder.tsx       # Custom filter UI (NEW)
│       │   ├── operation-progress.tsx   # Progress bar + stats (NEW)
│       │   └── operation-history.tsx    # Past operations table (NEW)
│       └── hooks/
│           └── use-bulk-operations.ts   # Data + polling hook (NEW)
├── app/
│   └── api/
│       └── bulk-operations/
│           ├── route.ts                 # GET list, POST create (NEW)
│           ├── [id]/
│           │   ├── route.ts             # GET details (NEW)
│           │   └── cancel/
│           │       └── route.ts         # POST cancel (NEW)
│           └── preview/
│               └── route.ts             # GET preview (NEW)
├── inngest/
│   └── functions/
│       ├── bulk-operation-execute.ts    # Fan-out function (NEW)
│       └── bulk-operation-complete.ts   # Completion handler (NEW)
└── lib/
    └── services/
        └── bulk-operations.ts           # Bulk ops service (NEW)
```

---

### 4. OOS (Out of Stock) Auto-Retry Queue

**Priority**: 🔴 Critical  
**Effort**: Low-Medium  
**Stakeholders**: Ops, Management

#### Purpose
Automatically retry orders that failed due to inventory issues, with configurable retry intervals and max attempts.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OOS AUTO-RETRY QUEUE                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONFIGURATION:                                                            │
│  ├─ Retry Interval: [24 hours ▼]                                          │
│  ├─ Max Retries: [7 ▼]                                                    │
│  ├─ Alert After: [3 retries ▼]                                            │
│  └─ Auto-Cancel After: [30 days ▼]                                        │
│                                                                             │
│  QUEUE STATS:                                                              │
│  ├─ Orders in queue: 47                                                   │
│  ├─ Auto-resolved today: 23                                               │
│  ├─ Avg resolution time: 1.3 days                                         │
│  └─ Manual intervention needed: 0                                         │
│                                                                             │
│  CURRENT QUEUE:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Order       │ SKU              │ Warehouse │ Retries │ Next Retry  │   │
│  ├─────────────┼──────────────────┼───────────┼─────────┼─────────────┤   │
│  │ IM8-521890  │ IM8-FG-000053    │ GPS US    │   3/7   │ In 4 hours  │   │
│  │ IM8-521891  │ IM8-FG-000053    │ GPS US    │   3/7   │ In 4 hours  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Retry All Now]  [Export Queue]  [Configure]                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model

```typescript
interface OOSQueueItem {
  id: string;
  orderId: string;
  shopifyOrderName: string;
  sku: string;
  warehouse: 'GPS_US' | 'GPS_UK' | 'GPS_CN' | 'STORD' | 'EXTENSIV';
  retryCount: number;
  maxRetries: number;
  lastRetryAt: Date | null;
  nextRetryAt: Date;
  error: string;
  status: 'queued' | 'retrying' | 'resolved' | 'exhausted' | 'cancelled';
  queuedAt: Date;
  resolvedAt: Date | null;
}

interface OOSConfig {
  retryIntervalHours: number;
  maxRetries: number;
  alertAfterRetries: number;
  autoCancelAfterDays: number;
}
```

#### Inngest Functions

| Function | Event | Description |
|----------|-------|-------------|
| `oos/order.detected` | `order/oos.detected` | Add order to OOS queue |
| `oos/retry.scheduled` | Cron: `0 */4 * * *` | Process due retries |
| `oos/retry.success` | `order/oos.resolved` | Remove from queue, notify |
| `oos/retry.exhausted` | Max retries reached | Alert Ops, escalate |

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/oos-queue` | List OOS queue with filters |
| GET | `/api/oos-queue/stats` | Queue statistics |
| POST | `/api/oos-queue/:id/retry` | Force immediate retry |
| POST | `/api/oos-queue/retry-all` | Retry all due orders |
| PUT | `/api/oos-queue/config` | Update OOS config |
| DELETE | `/api/oos-queue/:id` | Remove from queue |

#### Files to Create/Modify

```
src/
├── features/
│   └── oos-queue/
│       ├── index.tsx                    # Main OOS queue page (NEW)
│       ├── components/
│       │   ├── queue-stats.tsx          # Stats cards (NEW)
│       │   ├── queue-table.tsx          # Queue items table (NEW)
│       │   └── config-dialog.tsx        # Configuration modal (NEW)
│       └── hooks/
│           └── use-oos-queue.ts         # Data hook (NEW)
├── app/
│   └── api/
│       └── oos-queue/
│           ├── route.ts                 # GET list (NEW)
│           ├── stats/
│           │   └── route.ts             # GET stats (NEW)
│           ├── config/
│           │   └── route.ts             # PUT config (NEW)
│           ├── retry-all/
│           │   └── route.ts             # POST retry all (NEW)
│           └── [id]/
│               ├── route.ts             # DELETE remove (NEW)
│               └── retry/
│                   └── route.ts         # POST force retry (NEW)
├── inngest/
│   └── functions/
│       ├── oos-detected.ts              # Add to queue (NEW)
│       ├── oos-retry-scheduled.ts       # Cron retry (NEW)
│       └── oos-exhausted.ts             # Max retries alert (NEW)
└── lib/
    └── services/
        └── oos-queue.ts                 # OOS queue service (NEW)
```

---

### 5. Fulfillment Sync Monitor

**Priority**: 🟡 High  
**Effort**: Medium  
**Stakeholders**: Ops

#### Purpose
Track fulfillment status across GPS → D365 → Shopify pipeline with automatic detection of sync failures.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FULFILLMENT SYNC MONITOR                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SYNC PIPELINE STATUS:                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    GPS → D365 → Shopify                             │   │
│  │                                                                     │   │
│  │  GPS Fulfilled:     2,847                                          │   │
│  │  D365 Updated:      2,845  (2 pending)                             │   │
│  │  Shopify Fulfilled: 2,843  (4 pending)                             │   │
│  │                                                                     │   │
│  │  ⚠️  6 orders need attention                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PENDING SYNCS:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Order       │ GPS     │ D365    │ Shopify │ Issue          │ Action│   │
│  ├─────────────┼─────────┼─────────┼─────────┼────────────────┼───────┤   │
│  │ IM8-521890  │   ✅    │   ✅    │   ⏳    │ Retry in 2m    │ [Now] │   │
│  │ IM8-521891  │   ✅    │   ❌    │   --    │ D365 timeout   │ [Retry│   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Sync All Pending]  [View Sync Logs]  [Configure Alerts]                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Data Model

```typescript
interface FulfillmentSync {
  orderId: string;
  shopifyOrderName: string;
  warehouse: string;
  stages: {
    warehouseFulfilled: SyncStage;
    d365Updated: SyncStage;
    shopifyFulfilled: SyncStage;
  };
  trackingNumber: string | null;
  trackingCompany: string | null;
  fulfilledAt: Date | null;
}

interface SyncStage {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  completedAt: Date | null;
  error: string | null;
  retryCount: number;
}
```

#### Inngest Functions

| Function | Event | Description |
|----------|-------|-------------|
| `fulfillment/gps.received` | `gps/fulfillment.received` | Update GPS status, trigger D365 |
| `fulfillment/stord.received` | `stord/fulfillment.received` | Update Stord status, trigger D365 |
| `fulfillment/d365.sync` | `fulfillment/d365.requested` | Push to D365 |
| `fulfillment/shopify.sync` | `fulfillment/shopify.requested` | Update Shopify |
| `fulfillment/orphan.check` | Cron: `0 * * * *` | Find fulfilled but not synced |

#### Files to Create/Modify

```
src/
├── features/
│   └── fulfillment-sync/
│       ├── index.tsx                    # Main sync monitor page (NEW)
│       ├── components/
│       │   ├── sync-pipeline.tsx        # Visual pipeline status (NEW)
│       │   ├── pending-syncs-table.tsx  # Pending items table (NEW)
│       │   └── sync-logs.tsx            # Detailed logs view (NEW)
│       └── hooks/
│           └── use-fulfillment-sync.ts  # Data hook (NEW)
├── app/
│   └── api/
│       └── fulfillment-sync/
│           ├── route.ts                 # GET sync status (NEW)
│           ├── pending/
│           │   └── route.ts             # GET pending syncs (NEW)
│           └── sync-all/
│               └── route.ts             # POST sync all pending (NEW)
├── inngest/
│   └── functions/
│       └── fulfillment-orphan-check.ts  # Cron for orphaned fulfillments (NEW)
└── lib/
    └── services/
        └── fulfillment-sync.ts          # Sync tracking service (NEW)
```

---

### 6. Real-Time Alerts & Notifications

**Priority**: 🟡 High  
**Effort**: Low  
**Stakeholders**: Ops, Management

#### Purpose
Proactive Slack notifications for issues before they become crises.

#### Alert Rules

| Condition | Channel | Severity | Default |
|-----------|---------|----------|---------|
| Order stuck > 1 hour | #tech-ops | Warning | On |
| Order stuck > 4 hours | #tech-ops | Critical | On |
| Inventory < 10 units | #tech-ops | Critical | On |
| Inventory < 50 units | #tech-ops | Warning | On |
| Fulfillment sync failed 3x | #tech-ops | Critical | On |
| Bulk operation complete | #tech-ops | Info | On |
| Daily summary | #ops-daily | Info | On |
| OOS queue > 50 orders | #tech-ops | Warning | On |

#### Slack Message Format

```
🔴 CRITICAL: 47 orders stuck > 4 hours

Warehouse: GPS US
Common SKU: IM8-FG-000053 (0 stock)
Oldest order: IM8-521890 (6h 23m)

[View in Hub] [Retry All] [Snooze 1h]
```

#### Files to Create/Modify

```
src/
├── features/
│   └── alerts/
│       ├── index.tsx                    # Alert configuration page (NEW)
│       └── components/
│           ├── alert-rules-table.tsx    # Configure rules (NEW)
│           └── alert-history.tsx        # Past alerts (NEW)
├── app/
│   └── api/
│       └── alerts/
│           ├── route.ts                 # GET/PUT alert config (NEW)
│           └── history/
│               └── route.ts             # GET alert history (NEW)
├── inngest/
│   └── functions/
│       ├── alert-stuck-orders.ts        # Stuck order alerting (NEW)
│       ├── alert-low-inventory.ts       # Inventory alerting (NEW)
│       └── alert-daily-summary.ts       # Daily digest (NEW)
└── lib/
    └── services/
        └── alerts.ts                    # Alert service (NEW)
```

---

### 7. Finance Reconciliation Reports

**Priority**: 🟢 Medium  
**Effort**: Medium  
**Stakeholders**: Finance

#### Purpose
Automated daily/weekly/monthly reconciliation reports comparing orders across all systems.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RECONCILIATION REPORTS                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DAILY RECONCILIATION (2026-01-08):                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Shopify │   D365  │   GPS   │  Stord  │ Match│   │
│  ├────────────────────────────────┼─────────┼─────────┼─────────┼──────┤   │
│  │ Orders Created                 │   1,247 │  1,247  │    892  │   355│ ✅│
│  │ Orders Fulfilled               │   1,189 │  1,189  │    856  │   333│ ✅│
│  │ Revenue                        │ $89,234 │ $89,234 │ $63,421 │$25,813│ ✅│
│  │ Refunds                        │     23  │    23   │     18  │     5│ ✅│
│  │ Discrepancies                  │      0  │     0   │      0  │     0│ ✅│
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Daily CSV]  [Weekly Summary]  [Monthly Report]  [Custom Date Range]      │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Files to Create/Modify

```
src/
├── features/
│   └── reconciliation/
│       ├── index.tsx                    # Main reconciliation page (NEW)
│       └── components/
│           ├── daily-report.tsx         # Daily view (NEW)
│           ├── report-table.tsx         # Comparison table (NEW)
│           └── export-options.tsx       # Export buttons (NEW)
├── app/
│   └── api/
│       └── reconciliation/
│           ├── route.ts                 # GET report data (NEW)
│           └── export/
│               └── route.ts             # GET CSV export (NEW)
├── inngest/
│   └── functions/
│       └── reconciliation-generate.ts   # Scheduled report generation (NEW)
└── lib/
    └── services/
        └── reconciliation.ts            # Report generation service (NEW)
```

---

### 8. CS Order Lookup (Enhancement)

**Priority**: 🟢 Medium  
**Effort**: Low  
**Stakeholders**: CS

#### Purpose
Self-service order lookup for Customer Service team with full system status visibility.

#### Current State
- Basic order table exists
- Order detail dialog exists
- Needs: search, lifecycle view, action buttons

#### Enhancements Needed

```
src/
├── features/
│   └── orders/
│       ├── components/
│       │   ├── order-search.tsx         # Enhanced search (ENHANCE)
│       │   ├── order-detail.tsx         # Add lifecycle view (ENHANCE)
│       │   └── order-actions.tsx        # Retry/resync buttons (NEW)
```

---

### 9. System Health Dashboard

**Priority**: 🟢 Medium  
**Effort**: Low  
**Stakeholders**: Ops, Management

#### Purpose
Real-time visibility into all integration health and throughput.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SYSTEM HEALTH                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INTEGRATIONS:                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │ Shopify │ │  D365   │ │   GPS   │ │  Stord  │ │Extensiv │ │ Inngest │   │
│  │   ✅    │ │   ✅    │ │   ✅    │ │   ✅    │ │   ✅    │ │   ✅    │   │
│  │  12ms   │ │  89ms   │ │  234ms  │ │  156ms  │ │  178ms  │ │   8ms   │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│                                                                             │
│  THROUGHPUT (Last Hour):                                                   │
│  ├─ Orders Processed: 1,247                                               │
│  ├─ Avg Processing Time: 2.3s                                             │
│  ├─ Success Rate: 99.7%                                                   │
│  └─ Active Inngest Functions: 23                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Files to Create/Modify

```
src/
├── features/
│   └── dashboard/
│       ├── index.tsx                    # Main dashboard (ENHANCE)
│       └── components/
│           ├── integration-status.tsx   # Integration health cards (NEW)
│           ├── throughput-stats.tsx     # Processing stats (NEW)
│           └── queue-status.tsx         # Queue depths (NEW)
├── app/
│   └── api/
│       └── health/
│           ├── route.ts                 # GET system health (NEW)
│           └── integrations/
│               └── route.ts             # GET integration status (NEW)
└── lib/
    └── services/
        └── health.ts                    # Health check service (NEW)
```

---

### 10. Demo Replay Feature

**Priority**: 🔴 Critical (for POC)  
**Effort**: Low  
**Stakeholders**: Management (demo)

#### Purpose
Replay historical orders through Battle Bus to demonstrate performance vs Spock Store.

#### UI Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DEMO: REPLAY HISTORICAL ORDERS                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DATA SOURCE:                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ [Upload JSON ▼]  or  [Paste Order IDs]                             │   │
│  │                                                                     │   │
│  │ Loaded: 1,847 orders from Jan 8th incident                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  MODE:                                                                     │
│  ○ Dry Run (no API calls)                                                 │
│  ● Simulation (mock responses)                                            │
│  ○ Live (actual API calls - sandbox only)                                 │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  BATTLE BUS                          │  SPOCK STORE (from data)    │   │
│  │  ████████████████████░░░░░░ 75%      │  ████████████████████ 100%  │   │
│  │  1,385 / 1,847 orders                │  1,847 / 1,847 orders       │   │
│  │  ⏱️  Elapsed: 2m 18s                 │  ⏱️  Actual: 3h 35m         │   │
│  │  📊 Est. Total: 3m 05s               │                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [START DEMO]  [PAUSE]  [RESET]                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Files to Create/Modify

```
src/
├── features/
│   └── demo/
│       ├── index.tsx                    # Demo replay page (NEW)
│       └── components/
│           ├── data-loader.tsx          # Load historical data (NEW)
│           ├── race-visualization.tsx   # Side-by-side comparison (NEW)
│           └── demo-controls.tsx        # Start/pause/reset (NEW)
├── app/
│   └── api/
│       └── demo/
│           ├── route.ts                 # POST start demo (NEW)
│           └── status/
│               └── route.ts             # GET demo progress (NEW)
├── inngest/
│   └── functions/
│       └── demo-replay.ts               # Demo order processing (NEW)
└── lib/
    └── services/
        └── demo.ts                      # Demo service (NEW)
```

---

## Implementation Priority

### Phase 1: POC Demo (Days 1-2)
| Feature | Priority | Effort |
|---------|----------|--------|
| Demo Replay Feature | 🔴 Critical | Low |
| Order Lifecycle Tracker | 🔴 Critical | Medium |
| System Health Dashboard | 🟢 Medium | Low |

### Phase 2: Core Operations (Days 3-4)
| Feature | Priority | Effort |
|---------|----------|--------|
| Bulk Operations Center | 🔴 Critical | Medium |
| OOS Auto-Retry Queue | 🔴 Critical | Low-Medium |
| Real-Time Alerts | 🟡 High | Low |

### Phase 3: Monitoring & Reporting (Day 5)
| Feature | Priority | Effort |
|---------|----------|--------|
| Inventory Health Dashboard | 🔴 Critical | Medium |
| Fulfillment Sync Monitor | 🟡 High | Medium |
| CS Order Lookup (Enhancement) | 🟢 Medium | Low |

### Phase 4: Finance & Polish (Week 2)
| Feature | Priority | Effort |
|---------|----------|--------|
| Finance Reconciliation Reports | 🟢 Medium | Medium |
| SKU Mapping Center | 🟢 Medium | Medium |

---

## Database Schema

### New Tables Required

```sql
-- Order lifecycle tracking
CREATE TABLE order_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(255) NOT NULL UNIQUE,
  shopify_order_id VARCHAR(255) NOT NULL,
  shopify_order_name VARCHAR(255) NOT NULL,
  current_stage VARCHAR(50) NOT NULL,
  stages JSONB NOT NULL DEFAULT '[]',
  alerts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- OOS retry queue
CREATE TABLE oos_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(255) NOT NULL,
  shopify_order_name VARCHAR(255) NOT NULL,
  sku VARCHAR(255) NOT NULL,
  warehouse VARCHAR(50) NOT NULL,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 7,
  last_retry_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL,
  error TEXT,
  status VARCHAR(50) DEFAULT 'queued',
  queued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

-- Bulk operations
CREATE TABLE bulk_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  order_ids TEXT[] NOT NULL,
  total_count INTEGER NOT NULL,
  processed_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  started_by VARCHAR(255) NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'
);

-- Inventory snapshots
CREATE TABLE inventory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(255) NOT NULL,
  shopify_qty INTEGER,
  dynamics_qty INTEGER,
  gps_qty INTEGER,
  stord_qty INTEGER,
  extensiv_qty INTEGER,
  snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Alert history
CREATE TABLE alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  channel VARCHAR(255) NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  acknowledged_at TIMESTAMP WITH TIME ZONE
);
```

---

## Inngest Function Summary

| Category | Count | Functions |
|----------|-------|-----------|
| Order Processing | 5 | Existing + lifecycle tracking |
| Inventory | 4 | check, alert, sync, discrepancy |
| OOS Handling | 4 | detected, scheduled, success, exhausted |
| Fulfillment | 5 | gps, stord, d365, shopify, orphan-check |
| Bulk Operations | 3 | execute, process-order, complete |
| Alerts | 4 | stuck-orders, low-inventory, daily-summary, sync-failed |
| Reports | 2 | reconciliation-generate, export |
| Demo | 1 | demo-replay |
| **Total** | **28** | Enterprise-grade coverage |

---

## Success Metrics

### POC Demo Success
- [ ] Process 1,847 orders in < 5 minutes (vs 3h 35m Spock Store)
- [ ] Show real-time progress visualization
- [ ] Display order lifecycle for any order
- [ ] Show system health dashboard

### Production Success
- [ ] Zero "can we rerun the sync?" Slack messages
- [ ] Zero "please investigate this order" requests
- [ ] 100% automated OOS retry (no manual replays)
- [ ] < 5 minute average order processing time
- [ ] 99.9% fulfillment sync success rate
- [ ] Daily reconciliation reports auto-generated

---

## Next Steps

1. **Immediate**: Build Demo Replay Feature for POC presentation
2. **Day 1-2**: Order Lifecycle Tracker + System Health Dashboard
3. **Day 3-4**: Bulk Operations + OOS Queue + Alerts
4. **Day 5**: Inventory Dashboard + Fulfillment Monitor
5. **Week 2**: Finance Reports + Polish

---

*This document serves as the complete specification for Battle Hub POC. Every feature directly addresses a real pain point from production operations.*
