# IM8 Battle Bus 🚌⚡

> Operation Battle-Bus: Replacing spock-store's fragile polling system with durable, event-driven execution.

## Overview

The Battle Bus is a modern order orchestration engine that replaces the legacy spock-store Task Table polling system. It uses **Inngest** for durable execution and **Vercel** for serverless deployment.

### Key Benefits

| Metric | Old System (spock-store) | Battle Bus |
|--------|-------------------------|------------|
| Recovery Mode | Manual Reruns / SQL Scripts | Autonomous (Self-Healing) |
| Manual Effort | ~15-20 Engineering Hours/Week | < 1 Engineering Hour/Week |
| Task State | Binary (Processed/Error) | Stateful (Sleeping/Retrying) |
| System Load | High (Constant DB Polling) | Low (Push-on-Demand) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VERCEL EDGE                                  │
├─────────────────────────────────────────────────────────────────────┤
│  /api/webhooks/shopify  →  shopify/order.created                    │
│  /api/webhooks/shopify  →  shopify/refund.created                   │
│  /api/webhooks/gps      →  gps/fulfilment.received                  │
│  /api/webhooks/stord    →  stord/fulfilment.received                │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         INNGEST                                      │
├─────────────────────────────────────────────────────────────────────┤
│  processShopifyOrder     │ D365 Header → Lines → Confirm → GPS      │
│  processRefund           │ D365 Credit Note                         │
│  processGpsFulfilment    │ Shopify Fulfillment → D365 Packing Slip  │
│  processStordFulfilment  │ Shopify Fulfillment → D365 Packing Slip  │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DOWNSTREAM SYSTEMS                                │
├─────────────────────────────────────────────────────────────────────┤
│  Dynamics 365  │  GPS Warehouse  │  STORD  │  Shopify Admin          │
└─────────────────────────────────────────────────────────────────────┘
```

## Functions

| Function | Trigger | Description |
|----------|---------|-------------|
| `process-shopify-order` | `shopify/order.created` | Creates D365 sales order, sends to warehouse |
| `process-shopify-refund` | `shopify/refund.created` | Processes refunds, creates credit notes |
| `process-gps-fulfilment` | `gps/fulfilment.received` | Updates Shopify & D365 on GPS shipment |
| `process-stord-fulfilment` | `stord/fulfilment.received` | Updates Shopify & D365 on STORD shipment |

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Vercel account (for deployment)
- Inngest account (for production)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd im8-battle-bus

# Install dependencies
npm install

# Create environment file
touch .env.local
```

### Environment Variables

Create a `.env.local` file with:

```env
# Shopify Configuration
SHOPIFY_IM8_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_IM8_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-07
SHOPIFY_IM8_WEBHOOK_SECRET=your_webhook_secret

# Dynamics 365 Configuration
D365_BASE_URL=https://your-instance.operations.dynamics.com
D365_TENANT_ID=your-azure-tenant-id
D365_CLIENT_ID=your-azure-app-client-id
D365_CLIENT_SECRET=your-azure-app-client-secret
D365_RESOURCE=https://your-instance.operations.dynamics.com
D365_DATA_AREA_ID=U001

# GPS Warehouse Configuration
GPS_BASE_URL=https://api.gpswarehouse.com
GPS_API_KEY=your_gps_api_key
GPS_API_SECRET=your_gps_api_secret

# STORD Warehouse Configuration
STORD_BASE_URL=https://api.stord.com
STORD_API_KEY=your_stord_api_key
STORD_WEBHOOK_SECRET=your_stord_webhook_secret

# Feature Flags
DRY_RUN_MODE=true
ENABLE_DYNAMICS_SYNC=false
ENABLE_GPS_SYNC=false
ENABLE_STORD_SYNC=false
```

### Local Development

**Terminal 1 - Next.js Server:**
```bash
npm run dev
```

**Terminal 2 - Inngest Dev Server:**
```bash
npx inngest-cli@latest dev
```

**Terminal 3 - Tunnel (for Shopify webhooks):**
```bash
npx cloudflared tunnel --url http://localhost:3000
```

Visit:
- App: http://localhost:3000
- Inngest Dev UI: http://localhost:8288

### Testing Locally

Test the webhook endpoint without Shopify:

```bash
./scripts/test-webhook.sh
```

Or with curl:

```bash
curl -X POST http://localhost:3000/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/create" \
  -H "x-shopify-shop-domain: test-store.myshopify.com" \
  -d '{"id": 123, "name": "#TEST-1001", "email": "test@example.com", ...}'
```

### Connecting to Shopify

1. Start the tunnel: `npx cloudflared tunnel --url http://localhost:3000`
2. Copy the tunnel URL (e.g., `https://random-words.trycloudflare.com`)
3. In Shopify Admin → Settings → Notifications → Webhooks:
   - Create webhook for `Order creation`
   - URL: `https://YOUR-TUNNEL.trycloudflare.com/api/webhooks/shopify`

### Deployment

```bash
# Deploy to Vercel
vercel

# Or link and deploy to production
vercel link
vercel --prod
```

## Webhook Endpoints

Configure these endpoints in your external systems:

| System | Endpoint | Topics |
|--------|----------|--------|
| Shopify | `/api/webhooks/shopify` | `orders/create`, `orders/updated`, `refunds/create` |
| GPS | `/api/webhooks/gps` | Fulfilment notifications |
| STORD | `/api/webhooks/stord` | Fulfilment notifications |

## Self-Healing Features

### Out-of-Stock Retry

When GPS returns an out-of-stock error, the Battle Bus automatically:

1. Catches the `OutOfStockError`
2. Sleeps for 4 hours (configurable via `OOS_RETRY_HOURS`)
3. Retries the warehouse submission
4. Repeats until successful or max retries reached

```typescript
if (error instanceof OutOfStockError) {
  await step.sleep("wait-for-stock", "4h");
  await step.run("retry-gps-after-oos", async () => {
    return gps.createOutboundOrder(order);
  });
}
```

### Idempotency

All functions use idempotency keys to prevent duplicate processing:

- Orders: `shopifyOrderId`
- Refunds: `refundId`
- Fulfilments: `orderId + trackingNumber`

### Checkpointing

Each step is wrapped in `step.run()` for durable execution. If a function fails mid-way, it resumes from the last successful step:

```typescript
// Step 1: Create D365 header (checkpointed)
const d365Header = await step.run("create-d365-header", async () => {
  return dynamics.createSalesOrderHeader(header);
});

// Step 2: Create D365 lines (checkpointed)
await step.run("create-d365-lines", async () => {
  for (const line of lines) {
    await dynamics.createSalesOrderLine(line);
  }
});

// If Step 2 fails, Step 1 won't be re-executed on retry
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_DYNAMICS_SYNC` | `true` | Enable D365 integration |
| `ENABLE_GPS_SYNC` | `true` | Enable GPS warehouse |
| `ENABLE_STORD_SYNC` | `true` | Enable STORD warehouse |
| `DRY_RUN_MODE` | `false` | Log actions without executing |

## Migration from spock-store

### Phase 1: Shadow Pilot
- Deploy Battle Bus with `DRY_RUN_MODE=true`
- Configure Shopify to send duplicate webhooks
- Verify event capture and logging

### Phase 2: Integrity & Idempotency
- Enable `DRY_RUN_MODE=false` for non-critical functions
- Monitor for duplicate detection
- Verify idempotency keys working

### Phase 3: Self-Healing Cutover
- Point primary webhooks to Battle Bus
- Disable spock-store polling pods
- Monitor Inngest dashboard for issues

## Monitoring

- **Inngest Dashboard**: View function runs, retries, and errors at https://app.inngest.com
- **Inngest Dev UI**: Local debugging at http://localhost:8288
- **Vercel Logs**: View API route logs and errors
- **Vercel Analytics**: Monitor performance and usage

## Project Structure

```
src/
├── app/
│   └── api/
│       ├── inngest/route.ts      # Inngest handler
│       └── webhooks/
│           ├── shopify/route.ts  # Shopify webhook
│           ├── gps/route.ts      # GPS webhook
│           └── stord/route.ts    # STORD webhook
├── inngest/
│   ├── client.ts                 # Inngest client
│   ├── events.ts                 # Event type definitions
│   └── functions/
│       ├── index.ts
│       ├── process-shopify-order.ts
│       ├── process-refund.ts
│       ├── process-gps-fulfilment.ts
│       └── process-stord-fulfilment.ts
└── lib/
    ├── config.ts                 # Environment config
    ├── clients/
    │   ├── dynamics.ts           # D365 API client
    │   ├── gps.ts                # GPS API client
    │   └── shopify.ts            # Shopify API client
    ├── transformers/
    │   └── order.ts              # Order transformation logic
    └── types/
        ├── dynamics.ts           # D365 types
        └── gps.ts                # GPS types
```

## Development Status

See [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) for detailed completion checklist.

### What's Built
- [x] Inngest infrastructure (client, events, functions)
- [x] Webhook endpoints (Shopify, GPS, STORD)
- [x] Basic API clients (D365, GPS, Shopify)
- [x] Order transformer (basic)
- [x] Configuration & feature flags
- [x] Self-healing OOS retry logic

### What's Missing (from spock-store)
- [ ] SKU mappings (`dynamics/sku.json`, `extensiv/sku.json`)
- [ ] THK API endpoints for D365 (confirm, prepayment, fulfilment)
- [ ] GPS auth code generation (sorted key HMAC)
- [ ] Address transformer (UAE/SA postal code handling)
- [ ] Shipping/tax line creation
- [ ] Gift card & discount handling
- [ ] Warehouse routing (GPS vs GPS UK)

### Quick Start for Development
```bash
# 1. Fix npm permissions (if needed)
sudo chown -R $(whoami) ~/.npm

# 2. Terminal 1: Next.js
npm run dev

# 3. Terminal 2: Inngest Dev Server
npx inngest-cli@latest dev

# 4. Terminal 3: Test webhook
./scripts/test-webhook.sh

# 5. View Inngest UI
open http://localhost:8288
```

## License

Proprietary - IM8
