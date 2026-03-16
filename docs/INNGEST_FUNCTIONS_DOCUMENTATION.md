# Battle Bus & Battle Hub - Inngest Functions Documentation

> **Complete technical documentation of all Inngest functions, workflows, and processes for Battle Bus and Battle Hub**

---

## Table of Contents

1. [Overview](#overview)
2. [Function Categories](#function-categories)
3. [Order Processing Functions](#order-processing-functions)
4. [Inventory Management Functions](#inventory-management-functions)
5. [Product Management Functions](#product-management-functions)
6. [Fulfillment Functions](#fulfillment-functions)
7. [Battle Hub Action Functions](#battle-hub-action-functions)
8. [Location Management Functions](#location-management-functions)
9. [Missing Functionalities](#missing-functionalities)
10. [Workflow Diagrams](#workflow-diagrams)

---

## Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BATTLE BUS (Inngest)                        │
│                  Event-Driven Processing Engine                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   Shopify    │  │   D365       │  │   GPS/Stord   │        │
│  │   Webhooks   │→ │   Sync       │→ │   Warehouse   │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   Inventory  │  │   Product    │  │   Location    │        │
│  │   Sync       │  │   Sync       │  │   Sync        │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │   Hub Actions │  │   Cron Jobs   │                          │
│  │   (Cancel/    │  │   (GPS Sync)  │                          │
│  │    Refund/    │  │               │                          │
│  │    Fulfill)   │  │               │                          │
│  └──────────────┘  └──────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ Real-time Updates
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BATTLE HUB (Dashboard)                       │
│                  Operations & Monitoring UI                      │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technologies

- **Inngest**: Durable function execution with automatic retries
- **Vercel**: Serverless hosting for Next.js API routes
- **Supabase**: PostgreSQL database for order state
- **Inngest Realtime**: Real-time status updates to Battle Hub

---

## Function Categories

| Category                 | Functions | Purpose                                                |
| ------------------------ | --------- | ------------------------------------------------------ |
| **Order Processing**     | 5         | Handle order creation, updates, cancellations, refunds |
| **Inventory Management** | 4         | Sync inventory across Shopify, D365, GPS               |
| **Product Management**   | 1         | Sync product data across systems                       |
| **Fulfillment**          | 4         | Process fulfillments from warehouses                   |
| **Battle Hub Actions**   | 3         | Handle manual actions from dashboard                   |
| **Location Management**  | 1         | Sync location/warehouse mappings                       |
| **Cron Jobs**            | 1         | Scheduled GPS fulfillment polling                      |

**Total: 19 Functions**

---

## Order Processing Functions

### 1. `process-shopify-order`

**Function ID**: `process-shopify-order`  
**Trigger Events**:

- `shopify/order.created`
- `shopify/order.paid`

**Purpose**: Process new Shopify orders through the complete pipeline: D365 sales order creation → GPS warehouse order → Real-time tracking

**Workflow**:

```
1. Order Validation
   ├─ Test order check
   ├─ High-risk order filter
   ├─ Welcome kit filter
   └─ Fraud hold detection

2. Warehouse Routing
   ├─ Get fulfillment location from Shopify
   ├─ Map location to DataAreaId (D365)
   ├─ Determine warehouse (GPS US/UK/Stord)
   └─ Fallback to country-based routing

3. D365 Sales Order Creation
   ├─ Check for existing order (idempotency)
   ├─ Create sales order header
   ├─ Create sales order lines (parallel)
   ├─ Confirm sales order (smart retry)
   └─ Create prepayment (if applicable)

4. GPS Warehouse Order
   ├─ Build GPS payload
   ├─ Send to GPS warehouse
   ├─ Store GPS order ID in Shopify metafield
   └─ Handle out-of-stock retry (4h wait)

5. Real-time Updates
   ├─ Publish status to Inngest Realtime
   ├─ Send to CS Platform (Battle Hub)
   └─ Slack notifications
```

**Technical Details**:

- **Idempotency**: `event.data.shopifyOrderId`
- **Retries**: 5 attempts (default config)
- **Concurrency**: 5 orders per country simultaneously
- **Throttle**: Dynamics API rate limiting
- **Optimizations**:
  - Parallel line item creation
  - Smart D365 confirmation retry (exponential backoff)
  - Parallel prepayment + GPS payload building
  - Consolidated GPS send + metafield storage

**Key Features**:

- ✅ Automatic OOS retry with 4-hour wait
- ✅ Location-based warehouse routing
- ✅ Real-time step-by-step tracking
- ✅ Graceful error handling (continues on GPS failure)

**Output Events**:

- `order:${shopifyOrderName}` channel (Inngest Realtime)
- CS Platform order created event

---

### 2. `process-refund`

**Function ID**: `process-shopify-refund`  
**Trigger Event**: `shopify/refund.created`

**Purpose**: Process refunds by creating negative D365 sales order lines and posting fulfillments

**Workflow**:

```
1. Get Shopify Order
   └─ Fetch order details for name lookup

2. Get D365 Order
   └─ Lookup by Shopify order name

3. Determine Warehouse
   ├─ Get refund SKU (warehouse-specific)
   └─ Get return configuration

4. Calculate Refund Amount
   └─ Sum successful refund transactions

5. Create D365 Refund Line
   ├─ Negative quantity (-1)
   ├─ Price = refund amount
   └─ Link to original order

6. Fulfill Refund Line
   ├─ Create packing slip (return type)
   └─ Post to D365
```

**Technical Details**:

- **Idempotency**: `event.data.refundId`
- **Retries**: 5 attempts
- **Throttle**: Refund-specific rate limits
- **Concurrency**: 1 per order

**Output Events**:

- CS Platform refund event

---

### 3. `process-order-cancellation`

**Function ID**: `process-order-cancellation`  
**Trigger Event**: `shopify/order.cancelled`

**Purpose**: Orchestrate cancellation across GPS/D365 and keep Shopify state accurate when warehouse cancellation is no longer possible.

**Workflow**:

```
1. Get D365 Order
   └─ Lookup by Shopify order name

2. Resolve GPS Metadata
   ├─ Read Shopify order metafield (`battle_bus.gps_order`)
   └─ Ensure warehouse is GPS US/UK before GPS cancellation attempt

3. Cancel GPS Order (OMS)
   ├─ Submit `/openapi/v1/outboundOrder/cancel`
   ├─ Poll `/openapi/v1/outboundOrder/selectBizStatus`
   └─ Resolve terminal success/failure

4. Safeguard: Shopify Uncancel on GPS Failure
   ├─ If GPS cancellation fails (e.g. shipped/in-flight)
   ├─ Re-open Shopify order (`orders/{id}/open.json`)
   └─ Flag manual handling path and alert ops

5. D365 Cancellation Path
   └─ Run D365 cancellation/deletion path when applicable
```

**Technical Details**:

- **Idempotency**: `event.data.shopifyOrderId`
- **Retries**: 3 attempts (low priority)
- **Concurrency**: 1 per order
- **GPS OMS Polling Controls**:
  - `OMS_CANCEL_STATUS_POLL_ATTEMPTS`
  - `OMS_CANCEL_STATUS_POLL_INTERVAL_MS`

**Notes**:

- Canonical processing remains on `shopify/order.cancelled`.
- Hub cancel action also emits this canonical event to guarantee same downstream behavior.

**Output Events**:

- CS Platform cancellation event

---

### 4. `process-order-update`

**Function ID**: `process-order-update`  
**Trigger Event**: `shopify/order.updated`

**Purpose**: Handle order updates (address, notes, customer changes) with debouncing

**Workflow**:

```
1. Debounce (10s window)
   └─ Wait for rapid updates to settle

2. Check D365 Order
   └─ Verify order exists

3. Determine Update Actions
   ├─ Shipping address change
   ├─ Notes/tags change
   └─ Customer change

4. Update D365 Order
   └─ Update sales order header
```

**Technical Details**:

- **Debounce**: 10s period, 5m timeout
- **Throttle**: 10 per second per store
- **Concurrency**: 1 per order
- **Retries**: 3 attempts

**Output Events**:

- CS Platform order updated event

---

### 5. `process-shopify-fulfillment`

**Function ID**: `process-shopify-fulfillment`  
**Trigger Event**: `shopify/order.fulfilled`

**Purpose**: Sync fulfillments from Shopify (Stord, HK Warehouse) to D365

**Workflow**:

```
1. Identify Fulfillment Source
   ├─ GPS fulfillment? → Skip (handled by cron)
   ├─ Stord fulfillment? → Process
   └─ Direct fulfillment? → Process

2. Get D365 Order
   └─ Lookup by Shopify order name

3. Process Each Fulfillment
   ├─ Skip dummy/adjustment fulfillments
   ├─ Filter dummy SKUs
   ├─ Get lot ID mapping from D365
   ├─ Create D365 packing slip
   └─ Post fulfillment
```

**Technical Details**:

- **Idempotency**: `event.data.shopifyOrderId + '-' + event.id`
- **Retries**: 5 attempts
- **Concurrency**: 1 per order
- **Throttle**: Dynamics API rate limits

**Output Events**:

- CS Platform fulfillment event
- Slack notifications (Stord channel)

---

## Inventory Management Functions

### 6. `process-inventory-sync`

**Function ID**: `process-inventory-sync`  
**Trigger Event**: `shopify/inventory.updated`

**Purpose**: Sync inventory level changes from Shopify to D365 and GPS

**Workflow**:

```
1. Debounce (10s)
   └─ Avoid processing rapid-fire updates

2. Sync to D365
   └─ Update inventory level

3. Sync to GPS
   └─ Update warehouse inventory

4. Log Results
   └─ Slack notification on errors
```

**Technical Details**:

- **Debounce**: 10s period, keyed by `inventoryItemId + locationId`
- **Retries**: 5 attempts
- **Concurrency**: 5 simultaneous syncs

**Output Events**:

- Slack warnings on sync failures

---

### 7. `process-inventory-mesh`

**Function ID**: `process-inventory-mesh`  
**Trigger Event**: `inventory/sync`

**Purpose**: Unified inventory sync router that handles multi-directional syncs between platforms

**Workflow**:

```
1. Route by Destination
   ├─ shopify → Update Shopify inventory
   ├─ dynamics → Sync to D365 → Auto-trigger D365→Shopify
   └─ gps/warehouse → Sync to GPS warehouse

2. Notify Battle Hub
   └─ Update Supabase with sync status
```

**Technical Details**:

- **Retries**: 5 attempts
- **Concurrency**: 5 simultaneous syncs
- **Location Routing**: Maps Shopify locations to D365 dataAreaId

**Key Features**:

- ✅ Multi-directional sync support
- ✅ Automatic D365→Shopify cascade
- ✅ Location-based dataAreaId mapping
- ✅ Battle Hub callback integration

**Supported Routes**:

- `shopify → dynamics → shopify` (automatic cascade)
- `dynamics → shopify`
- `warehouse → dynamics → shopify`
- `shopify → gps`

---

### 8. `process-inventory-full-sync`

**Function ID**: `process-inventory-full-sync`  
**Trigger Event**: `inventory/sync.requested`

**Purpose**: Full inventory sync pipeline from Battle Hub (GPS → D365 → Shopify)

**Workflow**:

```
1. GPS Warehouse Sync
   ├─ Query GPS inventory (US + UK)
   ├─ Aggregate by SKU
   └─ Publish progress to Battle Hub

2. D365 Comparison
   ├─ Fetch D365 inventory
   ├─ Compare quantities
   └─ Detect drift

3. Shopify Sync (De-emphasized)
   └─ Informational only

4. Publish Final Result
   └─ Summary with drift detection
```

**Technical Details**:

- **Retries**: 5 attempts
- **Concurrency**: 1 (only one full sync at a time)
- **Real-time Updates**: Inngest Realtime channel `inventory:sync:{syncId}`

**Key Features**:

- ✅ Real-time progress streaming
- ✅ Drift detection (GPS vs D365)
- ✅ SKU filtering support
- ✅ Dry run mode

**Output Events**:

- Real-time status updates to Battle Hub
- Final summary with drift counts

---

### 9. `process-inventory-mesh` (Duplicate Entry)

_Note: This function is listed twice in the index. The mesh function handles both individual syncs and routing._

---

## Product Management Functions

### 10. `process-product-sync`

**Function ID**: `process-product-sync`  
**Trigger Events**:

- `shopify/product.created`
- `shopify/product.updated`
- `shopify/product.deleted`

**Purpose**: Sync product data from Shopify to D365 and GPS

**Workflow**:

```
1. Handle Deletion
   ├─ Delete from D365 (TODO)
   └─ Delete from GPS (TODO)

2. Extract Variant Data
   └─ Map SKUs, prices, barcodes, weights

3. Sync to D365
   └─ Create/update product with variants

4. Sync to GPS
   └─ Create/update product with SKUs

5. Fetch Location-wise Inventory
   └─ Get inventory levels by location

6. Notify Battle Hub
   └─ Send product data with inventory breakdown
```

**Technical Details**:

- **Retries**: 5 attempts
- **Concurrency**: 5 simultaneous syncs

**Known Limitations**:

- Product deletion not yet implemented (returns placeholder)

**Output Events**:

- CS Platform product created/updated/deleted events
- Slack notifications

---

## Fulfillment Functions

### 11. `cron-gps-sync`

**Function ID**: `cron-gps-sync`  
**Trigger**: Cron schedule (configurable, default: every N minutes)

**Purpose**: Poll GPS warehouse for fulfilled orders and create Shopify fulfillments

**Workflow**:

```
1. Get GPS Order IDs
   ├─ Query unfulfilled Shopify orders
   ├─ Extract GPS metafields
   └─ Group by warehouse (US/UK)

2. Query GPS in Batches
   ├─ Batch size: 10 orders
   ├─ Query both warehouses
   └─ Filter for status 3 (fulfilled) within time window

3. Process Fulfilled Orders
   ├─ Get Shopify fulfillment orders
   ├─ Create Shopify fulfillment with tracking
   └─ Trigger D365 sync via shopify/order.fulfilled event
```

**Technical Details**:

- **Schedule**: Configurable via `config.gps.scheduleIntervalMinutes`
- **Concurrency**: 1 (only one sync at a time)
- **Throttle**: Cron-specific rate limits
- **Batch Processing**: 10 orders per batch

**Key Features**:

- ✅ Batch processing to avoid timeouts
- ✅ GPS simulation support for testing
- ✅ Automatic D365 sync trigger
- ✅ All order status visibility (not just fulfilled)

**Output Events**:

- `shopify/order.fulfilled` (for D365 sync)
- Slack summary notifications

---

### 12. `process-extensiv-fulfillment`

**Function ID**: `process-extensiv-fulfillment`  
**Trigger Event**: `extensiv/fulfillment.received`

**Purpose**: Process fulfillments from Extensiv warehouse

**Status**: _Implementation details not fully reviewed in current codebase_

---

### 13. `process-extensiv-receiver-confirm`

**Function ID**: `process-extensiv-receiver-confirm`  
**Trigger Event**: `extensiv/receiver.confirm`

**Purpose**: Handle receiver confirmation from Extensiv

**Status**: _Implementation details not fully reviewed in current codebase_

---

### 14. `simulate-gps-fulfillment`

**Function ID**: `simulate-gps-fulfillment`  
**Trigger Event**: `gps/fulfillment.simulate`

**Purpose**: Simulate GPS fulfillments for testing

**Status**: _Testing utility function_

---

### 15. `process-gps-batch`

**Function ID**: `process-gps-batch`  
**Trigger Event**: `gps/batch.process`

**Purpose**: Process GPS orders in batch mode

**Status**: _Implementation details not fully reviewed in current codebase_

---

### 16. `process-gps-individual`

**Function ID**: `process-gps-individual`  
**Trigger Event**: `gps/individual.process`

**Purpose**: Process individual GPS orders

**Status**: _Implementation details not fully reviewed in current codebase_

---

## Battle Hub Action Functions

### 17. `process-action-cancel`

**Function ID**: `process-action-cancel`  
**Trigger Event**: `action/order.cancel`

**Purpose**: Track cancel actions triggered from Battle Hub dashboard.
The API route now also emits `shopify/order.cancelled` so canonical cancellation processing always runs.

**Workflow**:

```
1. Log Cancel Action
   └─ Record action details

2. Notify CS Platform
   └─ Send cancellation event (audit trail)

3. Canonical cancellation processing
   └─ Triggered by companion `shopify/order.cancelled` event emitted by `/api/actions/cancel`
```

**Technical Details**:

- **Retries**: 1 attempt
- **Note**: Actual Shopify cancellation is handled by API route; this function provides action tracking.

**Output Events**:

- CS Platform cancellation event

---

### 18. `process-action-refund`

**Function ID**: `process-action-refund`  
**Trigger Event**: `action/order.refund`

**Purpose**: Track refund actions triggered from Battle Hub dashboard

**Workflow**:

```
1. Log Refund Action
   └─ Record refund details (ID, amount, restock)

2. Note
   └─ D365 credit note handled by shopify/refund.created webhook
```

**Technical Details**:

- **Retries**: 1 attempt
- **Note**: Actual Shopify refund is handled by API route, this function provides tracking

**Output Events**:

- None (tracking only)

---

### 19. `process-action-fulfill`

**Function ID**: `process-action-fulfill`  
**Trigger Event**: `action/order.fulfill`

**Purpose**: Track fulfill actions triggered from Battle Hub dashboard

**Workflow**:

```
1. Log Fulfill Action
   └─ Record fulfillment details (ID, tracking, carrier)

2. Note
   └─ D365 sync handled by shopify/order.fulfilled webhook
```

**Technical Details**:

- **Retries**: 1 attempt
- **Note**: Actual Shopify fulfillment is handled by API route, this function provides tracking

**Output Events**:

- None (tracking only)

---

## Location Management Functions

### 20. `process-location-sync`

**Function ID**: `process-location-sync`  
**Trigger Events**:

- `shopify/location.created`
- `shopify/location.updated`
- `shopify/location.deleted`

**Purpose**: Sync Shopify location data to Battle Hub with warehouse mappings

**Workflow**:

```
1. Handle Deletion
   └─ Notify Battle Hub of location deletion

2. Get Warehouse Mapping
   ├─ Map location to warehouse name
   └─ Map location to D365 dataAreaId

3. Notify Battle Hub
   └─ Send location data with mappings
```

**Technical Details**:

- **Retries**: 5 attempts
- **Concurrency**: 5 simultaneous syncs

**Output Events**:

- CS Platform location events

---

## Missing Functionalities

Based on the Battle Hub POC Roadmap and current implementation, the following functionalities are missing:

### Critical Missing Features

#### 1. **Order Lifecycle Tracker**

- **Status**: ❌ Not Implemented
- **Priority**: 🔴 Critical
- **Description**: Visual representation of order journey through all systems
- **Required Functions**:
  - `order/lifecycle.track` - Track lifecycle updates after each step
  - `order/stale.check` - Cron to find stuck orders (>1h, >4h thresholds)
  - `order/stale.alert` - Slack alerts for stuck orders
- **Database Tables Needed**:
  - `order_lifecycle` - Store stage records and alerts
- **API Endpoints Needed**:
  - `GET /api/orders/:id/lifecycle` - Get full lifecycle
  - `GET /api/orders/stuck` - List stuck orders
  - `POST /api/orders/:id/retry` - Retry failed step

#### 2. **Bulk Operations Center**

- **Status**: ❌ Not Implemented
- **Priority**: 🔴 Critical
- **Description**: Mass retry/resync operations with progress tracking
- **Required Functions**:
  - `bulk/operation.execute` - Fan-out to individual order retries
  - `bulk/operation.process-order` - Process single order in bulk op
  - `bulk/operation.complete` - Send Slack summary
- **Database Tables Needed**:
  - `bulk_operations` - Store operation state and results
- **API Endpoints Needed**:
  - `GET /api/bulk-operations` - List operations
  - `GET /api/bulk-operations/:id` - Get progress
  - `POST /api/bulk-operations` - Start operation
  - `POST /api/bulk-operations/:id/cancel` - Cancel operation
  - `GET /api/bulk-operations/preview` - Preview matching orders

#### 3. **OOS (Out of Stock) Auto-Retry Queue**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🔴 Critical
- **Description**: Automatic retry for OOS orders with configurable intervals
- **Current State**: OOS detection exists in `process-shopify-order`, but no queue management
- **Required Functions**:
  - `oos/order.detected` - Add order to OOS queue
  - `oos/retry.scheduled` - Cron to process due retries (every 4h)
  - `oos/retry.success` - Remove from queue on success
  - `oos/retry.exhausted` - Alert when max retries reached
- **Database Tables Needed**:
  - `oos_queue` - Store OOS queue items
  - `oos_config` - Store retry configuration
- **API Endpoints Needed**:
  - `GET /api/oos-queue` - List queue
  - `GET /api/oos-queue/stats` - Queue statistics
  - `POST /api/oos-queue/:id/retry` - Force retry
  - `POST /api/oos-queue/retry-all` - Retry all due
  - `PUT /api/oos-queue/config` - Update config
  - `DELETE /api/oos-queue/:id` - Remove from queue

#### 4. **Inventory Health Dashboard**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🔴 Critical
- **Description**: Proactive inventory monitoring with alerts
- **Current State**: Inventory sync exists, but no health monitoring
- **Required Functions**:
  - `inventory/check.scheduled` - Cron to check inventory (hourly)
  - `inventory/alert.low-stock` - Send Slack notification on threshold breach
  - `inventory/sync.requested` - Manual sync trigger (exists as `process-inventory-full-sync`)
  - `inventory/discrepancy.detected` - Log and alert on mismatches
- **Database Tables Needed**:
  - `inventory_snapshots` - Store inventory snapshots
  - `inventory_thresholds` - Store alert thresholds per SKU
- **API Endpoints Needed**:
  - `GET /api/inventory` - List inventory with filters
  - `GET /api/inventory/:sku` - Get SKU details
  - `POST /api/inventory/sync` - Trigger manual sync
  - `POST /api/inventory/bulk-sync` - Bulk sync
  - `PUT /api/inventory/thresholds` - Update thresholds

#### 5. **Fulfillment Sync Monitor**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🟡 High
- **Description**: Track fulfillment status across GPS → D365 → Shopify pipeline
- **Current State**: Individual fulfillment functions exist, but no monitoring
- **Required Functions**:
  - `fulfillment/orphan.check` - Cron to find fulfilled but not synced (hourly)
  - `fulfillment/sync.status` - Track sync status per order
- **Database Tables Needed**:
  - `fulfillment_sync` - Store fulfillment sync status
- **API Endpoints Needed**:
  - `GET /api/fulfillment-sync` - Get sync status
  - `GET /api/fulfillment-sync/pending` - List pending syncs
  - `POST /api/fulfillment-sync/sync-all` - Sync all pending

### High Priority Missing Features

#### 6. **Real-Time Alerts & Notifications**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🟡 High
- **Description**: Proactive Slack notifications for issues
- **Current State**: Some Slack notifications exist, but no alert system
- **Required Functions**:
  - `alert/stuck-orders` - Alert for stuck orders
  - `alert/low-inventory` - Alert for low inventory
  - `alert/daily-summary` - Daily digest
  - `alert/sync-failed` - Alert for sync failures
- **Database Tables Needed**:
  - `alert_history` - Store alert history
  - `alert_rules` - Store alert configuration
- **API Endpoints Needed**:
  - `GET /api/alerts` - Get alert config
  - `PUT /api/alerts` - Update alert config
  - `GET /api/alerts/history` - Get alert history

#### 7. **Finance Reconciliation Reports**

- **Status**: ❌ Not Implemented
- **Priority**: 🟢 Medium
- **Description**: Automated daily/weekly/monthly reconciliation reports
- **Required Functions**:
  - `reconciliation/generate` - Scheduled report generation (daily)
  - `reconciliation/export` - CSV export generation
- **Database Tables Needed**:
  - `reconciliation_reports` - Store report data
- **API Endpoints Needed**:
  - `GET /api/reconciliation` - Get report data
  - `GET /api/reconciliation/export` - Get CSV export

### Medium Priority Missing Features

#### 8. **CS Order Lookup Enhancement**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🟢 Medium
- **Description**: Enhanced order lookup with lifecycle view
- **Current State**: Basic order table exists
- **Enhancements Needed**:
  - Add lifecycle visualization
  - Add action buttons (retry/resync)
  - Enhanced search

#### 9. **System Health Dashboard**

- **Status**: ⚠️ Partially Implemented
- **Priority**: 🟢 Medium
- **Description**: Real-time visibility into integration health
- **Required Functions**:
  - `health/integrations.check` - Check integration status
  - `health/throughput.monitor` - Monitor processing throughput
- **API Endpoints Needed**:
  - `GET /api/health` - Get system health
  - `GET /api/health/integrations` - Get integration status

#### 10. **Demo Replay Feature**

- **Status**: ❌ Not Implemented
- **Priority**: 🔴 Critical (for POC)
- **Description**: Replay historical orders to demonstrate performance
- **Required Functions**:
  - `demo/replay` - Process demo orders
- **API Endpoints Needed**:
  - `POST /api/demo` - Start demo
  - `GET /api/demo/status` - Get demo progress

---

## Workflow Diagrams

### Order Creation Flow

```
┌─────────────┐
│   Shopify   │
│   Webhook   │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ process-shopify-    │
│ order               │
└──────┬──────────────┘
       │
       ├─► Validate Order
       │
       ├─► Determine Warehouse
       │
       ├─► Create D365 SO
       │   ├─ Header
       │   ├─ Lines (parallel)
       │   └─ Confirm (smart retry)
       │
       ├─► Create Prepayment (if needed)
       │
       ├─► Send to GPS
       │   └─ Handle OOS retry
       │
       └─► Real-time Updates
           ├─ Inngest Realtime
           ├─ CS Platform
           └─ Slack
```

### Inventory Sync Flow

```
┌─────────────┐
│   Shopify   │
│  Inventory  │
│   Update    │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ process-inventory-  │
│ sync                │
└──────┬──────────────┘
       │
       ├─► Debounce (10s)
       │
       ├─► Sync to D365
       │
       └─► Sync to GPS
```

### Inventory Mesh Flow

```
┌─────────────┐
│  Inventory  │
│  Sync Event │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ process-inventory-   │
│ mesh                 │
└──────┬───────────────┘
       │
       ├─► Route by Destination
       │   ├─ shopify
       │   ├─ dynamics → auto-trigger shopify
       │   └─ gps/warehouse
       │
       └─► Notify Battle Hub
```

### Fulfillment Flow

```
┌─────────────┐
│   GPS       │
│  Warehouse  │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│  cron-gps-sync      │
│  (Scheduled Poll)   │
└──────┬──────────────┘
       │
       ├─► Query GPS API
       │
       ├─► Filter Fulfilled
       │
       ├─► Create Shopify Fulfillment
       │
       └─► Trigger D365 Sync
           │
           ▼
       ┌─────────────────────┐
       │ process-shopify-    │
       │ fulfillment         │
       └─────────────────────┘
```

---

## Summary Statistics

### Function Coverage

| Category             | Implemented | Missing | Total Required |
| -------------------- | ----------- | ------- | -------------- |
| Order Processing     | 5           | 0       | 5              |
| Inventory Management | 4           | 0       | 4              |
| Product Management   | 1           | 0       | 1              |
| Fulfillment          | 4           | 0       | 4              |
| Battle Hub Actions   | 3           | 0       | 3              |
| Location Management  | 1           | 0       | 1              |
| **Core Functions**   | **18**      | **0**   | **18**         |
| **Missing Features** | **0**       | **~15** | **~15**        |

### Missing Feature Breakdown

- **Critical**: 5 features (Order Lifecycle, Bulk Ops, OOS Queue, Inventory Health, Demo Replay)
- **High Priority**: 2 features (Fulfillment Monitor, Alerts)
- **Medium Priority**: 3 features (Reconciliation, CS Lookup Enhancement, System Health)

---

## Next Steps

1. **Immediate**: Implement Order Lifecycle Tracker (critical for visibility)
2. **Week 1**: Implement Bulk Operations Center and OOS Queue
3. **Week 2**: Implement Inventory Health Dashboard and Alerts
4. **Week 3**: Implement Fulfillment Monitor and System Health
5. **Week 4**: Implement Reconciliation Reports and Demo Replay

---

_Last Updated: 2026-01-08_
_Document Version: 1.0_
