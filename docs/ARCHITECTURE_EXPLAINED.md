# Battle Bus + Battle Hub Architecture

> **Battle Bus is the engine. Battle Hub is the cockpit.**

This document explains the complete architecture of the IM8 backend system.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                    THE BATTLE SYSTEM ARCHITECTURE                           │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                         BATTLE HUB                                    │  │
│  │                      (The Cockpit)                                    │  │
│  │                                                                       │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐     │  │
│  │  │   Order     │ │    Bulk     │ │    OOS      │ │  Inventory  │     │  │
│  │  │   Lookup    │ │ Operations  │ │   Queue     │ │  Dashboard  │     │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘     │  │
│  │                                                                       │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐     │  │
│  │  │  Lifecycle  │ │   Alerts    │ │   Reports   │ │   System    │     │  │
│  │  │   Tracker   │ │   Config    │ │  (Finance)  │ │   Health    │     │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘     │  │
│  │                                                                       │  │
│  │  Users: Ops, CS, Finance, Management                                 │  │
│  │  Stack: Next.js + Shadcn/ui + Firebase Auth                          │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    │ REST API / Inngest Events              │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                         BATTLE BUS                                    │  │
│  │                       (The Engine)                                    │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │                    INNGEST FUNCTIONS                            │ │  │
│  │  │                                                                 │ │  │
│  │  │  • process-shopify-order    • process-gps-fulfilment           │ │  │
│  │  │  • process-refund           • process-stord-fulfilment         │ │  │
│  │  │  • process-cancellation     • inventory-sync                   │ │  │
│  │  │  • oos-retry                • alert-notifications              │ │  │
│  │  │                                                                 │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                       │  │
│  │  Features:                                                           │  │
│  │  • ⚡ Event-driven (instant, no polling)                             │  │
│  │  • 🚀 Concurrent (10+ orders simultaneously)                         │  │
│  │  • 🔁 Auto-retry (configurable backoff)                              │  │
│  │  • 📝 Durable execution (checkpoint every step)                      │  │
│  │  • 🔒 Idempotent (no duplicate processing)                           │  │
│  │                                                                       │  │
│  │  Stack: Google Cloud Run + Inngest                                   │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    │ API Calls                              │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                      EXTERNAL SYSTEMS                                 │  │
│  │                                                                       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                    │  │
│  │  │ Shopify │ │  D365   │ │   GPS   │ │  Stord  │                    │  │
│  │  │ (Store) │ │  (ERP)  │ │  (3PL)  │ │  (3PL)  │                    │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘                    │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Why This Architecture?

### The Problem with Spock Store

```
SPOCK STORE (The Old Way)
─────────────────────────────────────────────────────────────────────────────

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Database   │◀────│   Poller     │────▶│   Process    │
│  (Task Table)│     │ (every 10s)  │     │  (1 at a time│
└──────────────┘     └──────────────┘     └──────────────┘
       ▲                                         │
       │                                         │
       └─────────────────────────────────────────┘
                    (update status)

Problems:
• 10-second delay between each order
• Sequential processing (parallel: 1)
• No visibility into queue state
• Manual retry required for failures
• No automatic OOS handling
• Database constantly polled

Result: 1,000 orders = 2+ hours
```

### The Solution with Battle Bus

```
BATTLE BUS (The New Way)
─────────────────────────────────────────────────────────────────────────────

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Shopify    │────▶│   Webhook    │────▶│   Inngest    │
│  (Instant)   │     │  (Instant)   │     │ (Concurrent) │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                                    ┌────────────┼────────────┐
                                    ▼            ▼            ▼
                              ┌─────────┐  ┌─────────┐  ┌─────────┐
                              │ Order 1 │  │ Order 2 │  │ Order 3 │
                              └─────────┘  └─────────┘  └─────────┘

Benefits:
• Instant webhook triggers (no polling)
• Concurrent processing (10+ at a time)
• Full visibility in Inngest dashboard
• Automatic retry with backoff
• Built-in OOS retry queue
• No database polling overhead

Result: 1,000 orders = 2 minutes
```

---

## Component Deep Dive

### Battle Hub (The Cockpit)

Battle Hub is the **operations dashboard** that gives Ops, CS, and Finance teams visibility and control without needing Engineering.

#### Features

| Feature                 | Purpose                                | Users      |
| ----------------------- | -------------------------------------- | ---------- |
| **Order Lookup**        | Search any order, see full status      | CS, Ops    |
| **Lifecycle Tracker**   | Visual pipeline of order journey       | CS, Ops    |
| **Bulk Operations**     | One-click retry/resync for many orders | Ops        |
| **OOS Queue**           | View and manage out-of-stock orders    | Ops        |
| **Inventory Dashboard** | Monitor stock across all systems       | Ops        |
| **Alerts Config**       | Configure Slack notifications          | Ops        |
| **Reports**             | Daily/weekly reconciliation            | Finance    |
| **System Health**       | Integration status at a glance         | Management |

#### How It Works

```
USER ACTION                    BATTLE HUB                      BATTLE BUS
───────────────────────────────────────────────────────────────────────────

CS searches order      →    Order Lookup Page      →    (reads from DB)
                            Shows lifecycle

Ops clicks "Retry"     →    Bulk Operations        →    Fires Inngest events
                            Shows progress              Processes orders

System detects OOS     →    OOS Queue Page         →    Auto-schedules retry
                            Shows queue status          Executes at interval

Alert threshold hit    →    Alert History          ←    Sends Slack
                            Shows notification          Logs to DB
```

---

### Battle Bus (The Engine)

Battle Bus is the **event processing engine** that handles all order operations with speed, reliability, and self-healing.

#### Core Concepts

**1. Event-Driven Architecture**

```
OLD: Poll database every 10 seconds, check for new tasks
NEW: Webhook arrives → Event fires → Processing starts instantly
```

**2. Concurrent Processing**

```typescript
// Process 3 orders per country simultaneously
concurrency: [{
  limit: 3,
  key: "event.data.orderJson.shipping_address.country_code"
}]

// Throttle D365 calls to 10/second
throttle: {
  limit: 10,
  period: "1s",
  key: "event.data.shopifyStore"
}
```

**3. Durable Execution (Checkpointing)**

```typescript
// Each step is saved - resume from failure
const d365Header = await step.run("create-d365-header", async () => {
  return dynamics.createSalesOrderHeaderV3(header);
});

const d365Lines = await step.run("create-d365-lines", async () => {
  return dynamics.createSalesOrderLines(lines);
});

// If step 2 fails, step 1 won't re-run on retry!
```

**4. Built-in Idempotency**

```typescript
// Same order ID = same result (no duplicates)
idempotency: "event.data.shopifyOrderId";
```

**5. Automatic OOS Retry**

```typescript
if (error instanceof OutOfStockError) {
  // Wait 4 hours, then retry automatically
  await step.sleep("wait-for-stock", "4h");
  await step.run("retry-gps-after-oos", async () => {
    return gps.createOutboundOrder(order);
  });
}
```

---

## Data Flow

### Order Creation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ORDER CREATION FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

1. WEBHOOK RECEIVED
   ┌─────────────┐
   │   Shopify   │──── POST /api/webhooks/shopify ────▶ Battle Bus
   │ orders/paid │                                      (instant)
   └─────────────┘

2. EVENT TRIGGERED
   ┌─────────────┐
   │   Inngest   │──── shopify/order.created ────▶ processShopifyOrder
   │   (queue)   │                                 (concurrent)
   └─────────────┘

3. PROCESSING STEPS (checkpointed)
   ┌─────────────────────────────────────────────────────────────────────┐
   │                                                                     │
   │  Step 1: Check existing order (idempotency)                        │
   │     ↓                                                               │
   │  Step 2: Create D365 header                                        │
   │     ↓                                                               │
   │  Step 3: Create D365 lines                                         │
   │     ↓                                                               │
   │  Step 4: Confirm D365 order                                        │
   │     ↓                                                               │
   │  Step 5: Create prepayment                                         │
   │     ↓                                                               │
   │  Step 6: Send to warehouse (GPS/Stord)                             │
   │     ↓                                                               │
   │  Step 7: Notify Battle Hub                                         │
   │                                                                     │
   └─────────────────────────────────────────────────────────────────────┘

4. LIFECYCLE TRACKED
   ┌─────────────┐
   │ Battle Hub  │◀──── Order lifecycle updated ────── Battle Bus
   │ (dashboard) │      (visible in real-time)
   └─────────────┘
```

### Fulfillment Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FULFILLMENT FLOW                                    │
└─────────────────────────────────────────────────────────────────────────────┘

1. WAREHOUSE SHIPS
   ┌─────────────┐
   │ GPS / Stord │──── POST /api/webhooks/gps ────▶ Battle Bus
   │  (shipped)  │     (tracking number)
   └─────────────┘

2. EVENT TRIGGERED
   ┌─────────────┐
   │   Inngest   │──── gps/fulfilment.received ────▶ processGpsFulfilment
   └─────────────┘

3. PROCESSING STEPS
   ┌─────────────────────────────────────────────────────────────────────┐
   │                                                                     │
   │  Step 1: Get Shopify order details                                 │
   │     ↓                                                               │
   │  Step 2: Create Shopify fulfillment (add tracking)                 │
   │     ↓                                                               │
   │  Step 3: Create D365 packing slip                                  │
   │     ↓                                                               │
   │  Step 4: Update lifecycle in Hub                                   │
   │                                                                     │
   └─────────────────────────────────────────────────────────────────────┘

4. CUSTOMER NOTIFIED
   ┌─────────────┐
   │   Shopify   │──── Email with tracking ────▶ Customer
   └─────────────┘
```

### Error Recovery Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ERROR RECOVERY FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

SCENARIO: Step 4 (confirm order) fails due to network error

1. FAILURE DETECTED
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Step 1: ✅ Check existing order                                   │
   │  Step 2: ✅ Create D365 header                                     │
   │  Step 3: ✅ Create D365 lines                                      │
   │  Step 4: ❌ Confirm D365 order  ←── FAILED (network timeout)       │
   └─────────────────────────────────────────────────────────────────────┘

2. AUTOMATIC RETRY (Inngest)
   ┌─────────────┐
   │   Inngest   │──── Retry attempt 1/5 ────▶ Step 4 only
   │  (backoff)  │     (steps 1-3 NOT re-run)
   └─────────────┘

3. IF STILL FAILING
   ┌─────────────┐
   │ Battle Hub  │──── Alert: "Order stuck at confirm" ────▶ Slack
   │  (visible)  │
   └─────────────┘

4. MANUAL INTERVENTION (if needed)
   ┌─────────────┐
   │    Ops      │──── Click "Retry" in Hub ────▶ Resumes from Step 4
   └─────────────┘
```

### OOS (Out of Stock) Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OOS AUTO-RETRY FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

1. OOS ERROR DETECTED
   ┌─────────────┐
   │     GPS     │──── "库存不足" (insufficient stock) ────▶ Battle Bus
   └─────────────┘

2. AUTOMATIC HANDLING
   ┌─────────────────────────────────────────────────────────────────────┐
   │                                                                     │
   │  catch (error) {                                                   │
   │    if (error instanceof OutOfStockError) {                         │
   │      // Add to OOS queue                                           │
   │      await step.sendEvent("oos/order.detected", { orderId });      │
   │                                                                     │
   │      // Wait 4 hours                                               │
   │      await step.sleep("wait-for-stock", "4h");                     │
   │                                                                     │
   │      // Retry automatically                                        │
   │      await step.run("retry-gps-after-oos", ...);                   │
   │    }                                                                │
   │  }                                                                  │
   │                                                                     │
   └─────────────────────────────────────────────────────────────────────┘

3. VISIBLE IN HUB
   ┌─────────────┐
   │ Battle Hub  │──── OOS Queue shows order ────▶ Ops can see status
   │  (OOS Page) │     "Next retry in 3h 42m"
   └─────────────┘

4. STOCK REPLENISHED → AUTO-RESOLVED
   ┌─────────────┐
   │   Inngest   │──── Retry succeeds ────▶ Order processed
   │  (4h later) │                          Hub updated
   └─────────────┘
```

---

## File Structure

```
battle-bus/
├── src/
│   ├── app/
│   │   └── api/
│   │       ├── inngest/
│   │       │   └── route.ts              # Inngest handler (brain)
│   │       └── webhooks/
│   │           ├── shopify/route.ts      # Shopify webhook entry
│   │           ├── gps/route.ts          # GPS webhook entry
│   │           └── stord/route.ts        # STORD webhook entry
│   │
│   ├── inngest/
│   │   ├── client.ts                     # Inngest client config
│   │   ├── events.ts                     # Event type definitions
│   │   └── functions/
│   │       ├── index.ts                  # Function exports
│   │       ├── process-shopify-order.ts  # Main order processing
│   │       ├── process-refund.ts         # Refund handling
│   │       ├── process-gps-fulfilment.ts # GPS fulfillment
│   │       ├── process-stord-fulfilment.ts # STORD fulfillment
│   │       └── process-order-cancellation.ts # Cancellation
│   │
│   ├── lib/
│   │   ├── clients/                      # External API clients
│   │   │   ├── dynamics.ts               # D365 API
│   │   │   ├── gps.ts                    # GPS API
│   │   │   ├── shopify.ts                # Shopify API
│   │   │   └── slack.ts                  # Slack notifications
│   │   │
│   │   ├── transformers/                 # Data transformation
│   │   │   ├── order.ts                  # Order → D365/GPS format
│   │   │   ├── address.ts                # Address formatting
│   │   │   └── sku.ts                    # SKU mapping
│   │   │
│   │   ├── helpers/                      # Utility functions
│   │   │   ├── warehouse.ts              # Warehouse routing
│   │   │   ├── country.ts                # Country code conversion
│   │   │   └── tracking.ts               # Tracking number parsing
│   │   │
│   │   ├── mappings/                     # Configuration data
│   │   │   ├── warehouse-config.json     # Warehouse settings
│   │   │   └── dynamics-sku.json         # SKU mappings
│   │   │
│   │   ├── config.ts                     # Environment config
│   │   └── types/                        # TypeScript types
│   │
│   └── features/                         # Battle Hub UI (if combined)
│       ├── orders/
│       ├── inventory/
│       ├── bulk-operations/
│       └── ...
│
├── docs/
│   ├── ARCHITECTURE_EXPLAINED.md         # This file
│   ├── BATTLE_HUB_POC_ROADMAP.md        # Feature specifications
│   ├── BATTLE_HUB_SIMPLE_OVERVIEW.md    # Non-technical overview
│   ├── PERFORMANCE_ANALYSIS.md          # Speed comparison
│   └── POC_DEMO_SCRIPT.md               # Demo presentation
│
└── scripts/
    ├── test-webhook.sh                   # Test webhook locally
    └── spock-store-timing-analysis.sql   # Extract Spock Store data
```

---

## Configuration

### Inngest Function Configuration

```typescript
// src/inngest/functions/process-shopify-order.ts

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",

    // Prevent duplicate processing
    idempotency: "event.data.shopifyOrderId",

    // Retry configuration
    retries: 5,

    // Concurrent processing (3 per country)
    concurrency: [
      {
        limit: 3,
        key: "event.data.orderJson.shipping_address.country_code",
      },
    ],

    // Throttle D365 calls (10/second per store)
    throttle: {
      limit: 10,
      period: "1s",
      key: "event.data.shopifyStore",
    },
  },
  { event: "shopify/order.created" },
  async ({ event, step }) => {
    // Processing logic...
  }
);
```

### Environment Variables

```env
# Feature Flags
DRY_RUN_MODE=false              # Log only, no API calls
ENABLE_DYNAMICS_SYNC=true       # Enable D365 integration
ENABLE_GPS_SYNC=true            # Enable GPS warehouse
ENABLE_STORD_SYNC=true          # Enable STORD warehouse

# Timing Configuration
OOS_RETRY_HOURS=4               # Hours to wait before OOS retry
MAX_OOS_RETRIES=7               # Maximum OOS retry attempts
```

---

## Comparison: Spock Store vs Battle Bus

| Aspect            | Spock Store                   | Battle Bus                 |
| ----------------- | ----------------------------- | -------------------------- |
| **Architecture**  | Polling + Task Table          | Event-driven + Inngest     |
| **Processing**    | Sequential (`parallel: 1`)    | Concurrent (10+ at a time) |
| **Speed**         | ~6 orders/minute              | ~600 orders/minute         |
| **Retry**         | Manual Slack request          | Automatic with backoff     |
| **OOS Handling**  | Manual replay next day        | Auto-retry after 4 hours   |
| **Idempotency**   | Custom DB query               | Built-in Inngest feature   |
| **Visibility**    | Check database manually       | Real-time dashboard        |
| **Checkpointing** | None (restart from beginning) | Every step saved           |
| **Scaling**       | Single Kubernetes pod         | Serverless auto-scale      |

---

## The Bottom Line

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  BATTLE BUS = The Engine                                                   │
│  • Processes orders 69x faster                                             │
│  • Self-healing with automatic retries                                     │
│  • Concurrent processing (not sequential)                                  │
│  • Durable execution (checkpoint every step)                               │
│                                                                             │
│  BATTLE HUB = The Cockpit                                                  │
│  • Self-service for Ops, CS, Finance                                       │
│  • Visual order lifecycle tracking                                         │
│  • One-click bulk operations                                               │
│  • Proactive alerts before crises                                          │
│                                                                             │
│  TOGETHER = The Future of IM8 Order Processing                             │
│                                                                             │
│  No more "can we rerun the sync?"                                          │
│  No more "please investigate this order"                                   │
│  No more 4,000 order backlogs                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. **Read the POC Roadmap**: [BATTLE_HUB_POC_ROADMAP.md](BATTLE_HUB_POC_ROADMAP.md)
2. **Understand the Performance**: [PERFORMANCE_ANALYSIS.md](PERFORMANCE_ANALYSIS.md)
3. **Prepare the Demo**: [POC_DEMO_SCRIPT.md](POC_DEMO_SCRIPT.md)
4. **Share with Stakeholders**: [BATTLE_HUB_SIMPLE_OVERVIEW.md](BATTLE_HUB_SIMPLE_OVERVIEW.md)
