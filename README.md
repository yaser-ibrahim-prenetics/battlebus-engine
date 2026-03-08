# Battle Bus + Battle Hub 🚌⚡

> **"Battle Bus is the engine. Battle Hub is the cockpit."**
>
> Together, they replace Spock Store with a system that's **69x faster**, **self-healing**, and **self-service**.

---

## The Problem We're Solving

Every week, our Slack channels are filled with messages like:

| Message                                    | Impact                  |
| ------------------------------------------ | ----------------------- |
| _"Can we rerun the sync?"_                 | Engineering time wasted |
| _"4000 orders still not fulfilled"_        | 17-day backlog          |
| _"Order created Dec 18 just synced Jan 2"_ | 15-day delay            |
| _"Please investigate this order"_          | Manual investigation    |

**The root cause:** Spock Store processes orders **one at a time** with a 10-second polling interval.

```
Spock Store: 1,000 orders = 2+ hours (sequential)
Battle Bus:  1,000 orders = 2 minutes (concurrent)
```

---

## The Solution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                         IM8 BACKEND SYSTEM                                  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                         BATTLE HUB                                    │  │
│  │                      (The Cockpit)                                    │  │
│  │                                                                       │  │
│  │   👁️ Visibility    🔄 Operations    📊 Reports    🔔 Alerts          │  │
│  │                                                                       │  │
│  │   • Order Lookup   • Bulk Retry     • Reconciliation  • Slack        │  │
│  │   • Lifecycle      • Manual Sync    • Daily Summary   • Email        │  │
│  │   • Inventory      • OOS Queue      • CSV Export      • In-App       │  │
│  │   • System Health  • Demo Replay    • Snapshots                      │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    │ Triggers Events / Reads Status         │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                         BATTLE BUS                                    │  │
│  │                       (The Engine)                                    │  │
│  │                                                                       │  │
│  │   ⚡ Event-Driven    🔁 Auto-Retry    🚀 Concurrent    📝 Durable    │  │
│  │                                                                       │  │
│  │   • 10 orders/second (vs 1 order/10 seconds)                         │  │
│  │   • Automatic OOS retry (no manual replay)                           │  │
│  │   • Built-in idempotency (no duplicates)                             │  │
│  │   • Step-by-step checkpointing (resume on failure)                   │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    │ API Calls                              │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │                      EXTERNAL SYSTEMS                                 │  │
│  │                                                                       │  │
│  │   🛒 Shopify    📦 D365    🏭 GPS    📦 Stord    📦 Extensiv         │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Why Battle Bus + Hub?

### For Ops Team

| Before (Spock Store)          | After (Battle Bus + Hub)    |
| ----------------------------- | --------------------------- |
| "Can we rerun the sync?"      | One-click bulk retry in Hub |
| Manual order investigation    | Order Lifecycle Tracker     |
| No warning before stockout    | Proactive inventory alerts  |
| OOS orders need manual replay | Automatic OOS retry queue   |

### For CS Team

| Before                           | After                     |
| -------------------------------- | ------------------------- |
| Ask Engineering for order status | Self-service Order Lookup |
| Can't see where order is stuck   | Visual lifecycle pipeline |

### For Finance Team

| Before                    | After                           |
| ------------------------- | ------------------------------- |
| Manual reconciliation     | Automated daily reports         |
| Order count discrepancies | Automatic discrepancy detection |

### For Management

| Before                             | After                          |
| ---------------------------------- | ------------------------------ |
| Find out about problems from Slack | Proactive alerts before crises |
| No visibility into system health   | Real-time dashboard            |

---

## Performance Comparison

### The Math

| Scenario                          | Spock Store | Battle Bus   | Improvement       |
| --------------------------------- | ----------- | ------------ | ----------------- |
| Daily Skio burst (1,375 orders)   | ~80 minutes | ~2.5 minutes | **32x faster**    |
| January 8th resync (1,847 orders) | 3h 35m      | ~3 minutes   | **69x faster**    |
| 7,000 order OOS backlog           | 6h 48m      | ~12 minutes  | **34x faster**    |
| December backlog (4,000 orders)   | 17 days     | ~7 minutes   | **3,500x faster** |

### Why?

```
SPOCK STORE                          BATTLE BUS
─────────────────────────────────    ─────────────────────────────────
Poll DB (10s wait)                   Webhook arrives (instant)
    ↓                                    ↓
Process 1 order                      Process 10 orders simultaneously
    ↓                                    ↓
Poll DB (10s wait)                   Process next 10 orders
    ↓                                    ↓
Process 1 order                      ... (concurrent processing)
    ↓
... (sequential, one at a time)

Rate: ~6 orders/minute               Rate: ~600 orders/minute
```

---

## Key Features

### 1. Concurrent Processing

```typescript
// Battle Bus processes multiple orders simultaneously
concurrency: [
  {
    limit: 3, // 3 orders per country at once
    key: "event.data.orderJson.shipping_address.country_code",
  },
];
```

### 2. Automatic OOS Retry

```typescript
// No more manual replays - system handles it
if (error instanceof OutOfStockError) {
  await step.sleep("wait-for-stock", "4h");  // Wait 4 hours
  await step.run("retry-gps-after-oos", ...); // Auto-retry
}
```

### 3. Built-in Idempotency

```typescript
// Duplicate webhooks? No problem.
idempotency: "event.data.shopifyOrderId";
```

### 4. Durable Execution

```typescript
// Each step is checkpointed - resume from failure
const d365Header = await step.run("create-d365-header", ...);
const d365Lines = await step.run("create-d365-lines", ...);
// If step 2 fails, step 1 won't re-run on retry
```

### 5. Visual Observability

- See every order's journey through the pipeline
- Click to see exact step that failed
- One-click retry from Inngest dashboard

---

## The Stack

| Component         | Technology          | Purpose                 |
| ----------------- | ------------------- | ----------------------- |
| **Battle Hub**    | Next.js + Shadcn/ui | Operations dashboard    |
| **Battle Bus**    | Inngest + Vercel    | Event processing engine |
| **Auth**          | Firebase            | User management         |
| **Database**      | PostgreSQL          | Order state & lifecycle |
| **Notifications** | Slack API           | Proactive alerts        |

### Why Vercel + Inngest?

Used by industry leaders:

- **Vercel**: The Washington Post, eBay, GitHub, Notion
- **Inngest**: SoundCloud, Resend, Clerk

---

## Order Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Shopify   │────▶│  Webhooks   │────▶│   Inngest   │────▶│  D365/GPS   │
│   (Store)   │     │  (Instant)  │     │ (Concurrent)│     │  (Fulfil)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                                       │
       │                                       │
       ▼                                       ▼
┌─────────────┐                         ┌─────────────┐
│ Battle Hub  │◀────────────────────────│  Lifecycle  │
│ (Dashboard) │                         │  (Tracked)  │
└─────────────┘                         └─────────────┘
```

### Happy Path

1. Customer orders on Shopify
2. Webhook triggers Battle Bus instantly
3. D365 sales order created (with checkpointing)
4. Order sent to GPS/Stord warehouse
5. Warehouse ships, sends fulfillment webhook
6. Battle Bus updates Shopify + D365
7. Customer gets tracking email

### Error Recovery

1. Step fails (network error, timeout, etc.)
2. Inngest auto-retries (up to 5 times)
3. If still failing, visible in dashboard
4. One-click retry from Hub or Inngest UI
5. Resumes from failed step (not from beginning)

---

## Inngest Functions

| Function                   | Trigger                     | Description                         |
| -------------------------- | --------------------------- | ----------------------------------- |
| `process-shopify-order`    | `shopify/order.created`     | Creates D365 SO, sends to warehouse |
| `process-refund`           | `shopify/refund.created`    | Creates D365 credit note            |
| `process-gps-fulfilment`   | `gps/fulfilment.received`   | Updates Shopify + D365              |
| `process-stord-fulfilment` | `stord/fulfilment.received` | Updates Shopify + D365              |
| `process-cancellation`     | `shopify/order.cancelled`   | Cancels in GPS + D365               |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Vercel account
- Inngest account

### Installation

```bash
# Clone the repository
git clone git@github.com:Prenetics/battle-bus.git
cd battle-bus

# Install dependencies
npm install

# Create environment file
cp .env.example .env.local
```

### Local Development

```bash
# Terminal 1: Next.js server
npm run dev

# Terminal 2: Inngest dev server
npx inngest-cli@latest dev

# Terminal 3: Tunnel for webhooks (optional)
npx cloudflared tunnel --url http://localhost:3000
```

Visit:

- App: http://localhost:3000
- Inngest Dev UI: http://localhost:8288

### Testing

```bash
# Test webhook endpoint
./scripts/test-webhook.sh

# Or with curl
curl -X POST http://localhost:3000/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/create" \
  -d '{"id": 123, "name": "#TEST-1001"}'
```

---

## Environment Variables

```env
# Shopify
SHOPIFY_IM8_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_IM8_ACCESS_TOKEN=shpat_xxxxx
SHOPIFY_IM8_WEBHOOK_SECRET=your_secret

# Dynamics 365
D365_BASE_URL=https://your-instance.operations.dynamics.com
D365_TENANT_ID=your-tenant-id
D365_CLIENT_ID=your-client-id
D365_CLIENT_SECRET=your-client-secret

# GPS Warehouse
GPS_BASE_URL=https://api.gpswarehouse.com
GPS_API_KEY=your_api_key
GPS_API_SECRET=your_api_secret

# STORD Warehouse
STORD_BASE_URL=https://api.stord.com
STORD_API_KEY=your_api_key

# Feature Flags
DRY_RUN_MODE=false
ENABLE_DYNAMICS_SYNC=true
ENABLE_GPS_SYNC=true
```

---

## Project Structure

```
src/
├── app/
│   └── api/
│       ├── inngest/route.ts           # Inngest handler
│       └── webhooks/
│           ├── shopify/route.ts       # Shopify webhooks
│           ├── gps/route.ts           # GPS webhooks
│           └── stord/route.ts         # STORD webhooks
├── inngest/
│   ├── client.ts                      # Inngest client
│   ├── events.ts                      # Event definitions
│   └── functions/                     # Processing functions
│       ├── process-shopify-order.ts
│       ├── process-refund.ts
│       ├── process-gps-fulfilment.ts
│       └── process-stord-fulfilment.ts
└── lib/
    ├── clients/                       # API clients
    │   ├── dynamics.ts
    │   ├── gps.ts
    │   └── shopify.ts
    ├── transformers/                  # Data transformers
    │   ├── order.ts
    │   ├── address.ts
    │   └── sku.ts
    └── mappings/                      # Configuration
        ├── warehouse-config.json
        └── dynamics-sku.json
```

---

## Documentation

| Document                                                            | Description                        |
| ------------------------------------------------------------------- | ---------------------------------- |
| [ARCHITECTURE_EXPLAINED.md](docs/ARCHITECTURE_EXPLAINED.md)         | Deep dive into system architecture |
| [BATTLE_HUB_POC_ROADMAP.md](docs/BATTLE_HUB_POC_ROADMAP.md)         | Complete feature specifications    |
| [BATTLE_HUB_SIMPLE_OVERVIEW.md](docs/BATTLE_HUB_SIMPLE_OVERVIEW.md) | Non-technical overview             |
| [PERFORMANCE_ANALYSIS.md](docs/PERFORMANCE_ANALYSIS.md)             | Detailed performance comparison    |
| [POC_DEMO_SCRIPT.md](docs/POC_DEMO_SCRIPT.md)                       | Demo presentation script           |
| [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)                         | Development progress               |

---

## The Bottom Line

**No more:**

- ❌ "Can we rerun the sync?"
- ❌ "Please investigate this order"
- ❌ "4000 orders still not fulfilled"
- ❌ "Order created Dec 18 just synced Jan 2"

**Instead:**

- ✅ Self-service bulk operations
- ✅ Visual order lifecycle tracking
- ✅ Automatic OOS retry
- ✅ Proactive alerts before problems

---

## Migration from Spock Store

### Phase 1: Shadow Mode

- Deploy Battle Bus with `DRY_RUN_MODE=true`
- Capture same webhooks as Spock Store
- Compare processing times

### Phase 2: Parallel Run

- Enable Battle Bus for non-critical flows
- Monitor for issues
- Validate idempotency

### Phase 3: Cutover

- Point primary webhooks to Battle Bus
- Disable Spock Store polling
- Monitor via Battle Hub dashboard

---

## Success Metrics

| Metric                | Spock Store     | Battle Bus Target   |
| --------------------- | --------------- | ------------------- |
| Order processing time | ~10s per order  | <1s per order       |
| Daily Skio burst      | ~80 minutes     | <3 minutes          |
| Manual retries/week   | 15-20 hours     | <1 hour             |
| OOS resolution        | Manual next-day | Automatic 4-hour    |
| Visibility            | Check database  | Real-time dashboard |

---

## License

Proprietary - Prenetics / IM8

---

<p align="center">
  <strong>Battle Bus is the engine. Battle Hub is the cockpit.</strong><br>
  <em>Together, they're the future of IM8 order processing.</em>
</p>
