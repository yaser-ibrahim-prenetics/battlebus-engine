# Battle Bus Project Status

## Overview

Battle Bus is an event-driven replacement for spock-store, handling the Shopify → D365 → GPS/STORD integration using Vercel + Inngest for durable execution.

**Status: READY FOR TESTING**

---

## ✅ Core Components (Complete)

### Infrastructure
- [x] Next.js 15 with App Router
- [x] Inngest SDK integration
- [x] TypeScript configuration
- [x] Environment-based configuration

### Webhook Endpoints
- [x] `/api/webhooks/shopify` - Orders, refunds, cancellations
- [x] `/api/webhooks/gps` - GPS fulfilment notifications
- [x] `/api/webhooks/stord` - STORD fulfilment notifications
- [x] `/api/inngest` - Inngest function handler

### Inngest Functions
- [x] `process-shopify-order` - Full order flow with OOS retry
- [x] `process-refund` - Refund/credit note handling
- [x] `process-gps-fulfilment` - GPS → Shopify → D365 fulfilment
- [x] `process-stord-fulfilment` - STORD → Shopify → D365 fulfilment
- [x] `process-order-cancellation` - Order cancellation flow

### API Clients
- [x] D365 client with THK API endpoints (V3 headers, confirm, prepayment, fulfilment)
- [x] GPS client with correct auth code algorithm (sorted-key HMAC)
- [x] Shopify client (orders, fulfillments, webhooks)

### Business Logic
- [x] SKU mappings (refill, reward, merge)
- [x] Warehouse configuration (GPS US, GPS UK, STORD, HK)
- [x] Address transformer (UAE/SA postal code handling)
- [x] Warehouse routing by country
- [x] Country code ISO2→ISO3 conversion

---

## 🧪 Testing Plan

### Phase 1: Local Testing (No External Systems)

**Goal:** Verify webhook ingress and Inngest function execution

```bash
# Terminal 1: Start Next.js
npm run dev

# Terminal 2: Start Inngest Dev Server
npx inngest-cli@latest dev

# Terminal 3: Send test webhook
./scripts/test-webhook.sh
```

**Verify:**
- [ ] Webhook endpoint returns 200
- [ ] Event appears in Inngest Dev UI (http://localhost:8288)
- [ ] Function executes with DRY_RUN_MODE=true
- [ ] All steps complete without error

### Phase 2: Shopify Test Store Integration

**Goal:** Receive real webhooks from test store

**Setup:**
1. Create Cloudflare tunnel: `npx cloudflared tunnel --url http://localhost:3000`
2. Add webhook in Shopify test store:
   - URL: `https://<tunnel-url>/api/webhooks/shopify`
   - Topics: orders/create, orders/paid, refunds/create, orders/cancelled

**Test Cases:**
- [ ] Place test order → verify event received
- [ ] Cancel test order → verify cancellation event
- [ ] Create refund → verify refund event

### Phase 3: D365 Sandbox Testing

**Goal:** Verify D365 integration with sandbox credentials

**Environment:**
```
DRY_RUN_MODE=false
D365_BASE_URL=<sandbox-url>
D365_TENANT_ID=<sandbox-tenant>
D365_CLIENT_ID=<sandbox-client>
D365_CLIENT_SECRET=<sandbox-secret>
ENABLE_GPS_SYNC=false  # Disable GPS for this phase
```

**Test Cases:**
- [ ] Order creates D365 header with THK fields
- [ ] Order lines created correctly
- [ ] Order confirmed via THK API
- [ ] Prepayment created via THK API
- [ ] Idempotency: same order twice → no duplicate

### Phase 4: GPS Sandbox Testing

**Goal:** Verify GPS integration

**Environment:**
```
DRY_RUN_MODE=false
GPS_BASE_URL=<sandbox-or-prod>
GPS_API_KEY=<key>
GPS_API_SECRET=<secret>
ENABLE_DYNAMICS_SYNC=false  # Test GPS in isolation
```

**Test Cases:**
- [ ] Auth code generates correctly
- [ ] Order submitted to GPS
- [ ] OOS error triggers sleep + retry
- [ ] GPS webhook received and processed

### Phase 5: Shadow Production

**Goal:** Run parallel to spock-store without writes

**Setup:**
1. Deploy to Vercel preview branch
2. Add Battle Bus as second webhook in production Shopify
3. Set `DRY_RUN_MODE=true`

**Monitor:**
- [ ] All production orders received
- [ ] Transformations match spock-store output
- [ ] No errors in Inngest dashboard
- [ ] Performance acceptable

### Phase 6: Canary Deployment

**Goal:** Process real orders through Battle Bus

**Rollout:**
1. Enable D365 sync first (`ENABLE_DYNAMICS_SYNC=true`)
2. Monitor for 24 hours
3. Enable GPS sync (`ENABLE_GPS_SYNC=true`)
4. Monitor for 24 hours
5. Disable spock-store webhooks

---

## 📋 Test Checklist

### Webhook Tests
| Test | Command | Expected |
|------|---------|----------|
| Shopify order | `./scripts/test-webhook.sh` | 200 + event in Inngest |
| Invalid signature | curl with wrong HMAC | 401 Unauthorized |
| Malformed JSON | curl with bad body | 500 error logged |

### Order Flow Tests
| Test | Trigger | Expected |
|------|---------|----------|
| New order | Shopify order webhook | D365 header + lines + confirm + prepay + GPS |
| Duplicate order | Same webhook twice | Second run skipped (idempotency) |
| Out of stock | GPS returns OOS | Sleep 4h then retry |
| Order cancellation | Cancel in Shopify | GPS cancel + D365 cancel |

### Fulfilment Tests
| Test | Trigger | Expected |
|------|---------|----------|
| GPS shipped | GPS webhook | Shopify fulfillment + D365 packing slip |
| STORD shipped | STORD webhook | Shopify fulfillment + D365 packing slip |

### Error Handling Tests
| Test | Trigger | Expected |
|------|---------|----------|
| D365 auth failure | Invalid credentials | Retry with backoff |
| GPS timeout | Network issue | Retry with backoff |
| Inngest crash mid-step | Kill process | Resume from checkpoint |

---

## 🔧 Environment Variables

```bash
# Required for all environments
SHOPIFY_IM8_ACCESS_TOKEN=
SHOPIFY_IM8_WEBHOOK_SECRET=

# D365 (required if ENABLE_DYNAMICS_SYNC=true)
D365_BASE_URL=
D365_TENANT_ID=
D365_CLIENT_ID=
D365_CLIENT_SECRET=
D365_SCOPE=

# GPS (required if ENABLE_GPS_SYNC=true)
GPS_BASE_URL=https://api.xlwms.com
GPS_API_KEY=
GPS_API_SECRET=

# Feature Flags
DRY_RUN_MODE=true          # Set false for real writes
ENABLE_DYNAMICS_SYNC=true
ENABLE_GPS_SYNC=true
ENABLE_STORD_SYNC=false

# Retry Configuration
OOS_RETRY_HOURS=4
```

---

## 📊 Success Criteria

### Phase 1-2 (Local + Shopify)
- [ ] 100% of test webhooks processed
- [ ] No unhandled exceptions
- [ ] Events visible in Inngest UI

### Phase 3-4 (D365 + GPS)
- [ ] Orders created in sandbox D365
- [ ] Orders submitted to GPS
- [ ] Idempotency working (no duplicates)

### Phase 5 (Shadow)
- [ ] 24 hours with no errors
- [ ] All production orders received
- [ ] Transformation output matches spock-store

### Phase 6 (Canary)
- [ ] First 10 orders successful
- [ ] First 100 orders successful
- [ ] 24 hours stable
- [ ] Ready to disable spock-store

---

## 🚀 Post-Launch Enhancements (Optional)

These are NOT required for launch:

| Feature | Priority | Notes |
|---------|----------|-------|
| Gift card audit trail | Low | Tracks gift card usage in D365 comments |
| Tracking URL generation | Low | UX enhancement for customers |
| Return order creation | Low | For physical returns |
| Daily reconciliation cron | Medium | Automated discrepancy detection |
| Slack notifications | Low | Alert on errors |

---

## 📁 Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── inngest/route.ts       # Inngest handler
│   │   └── webhooks/
│   │       ├── shopify/route.ts   # Shopify webhooks
│   │       ├── gps/route.ts       # GPS webhooks
│   │       └── stord/route.ts     # STORD webhooks
│   └── page.tsx
├── inngest/
│   ├── client.ts                  # Inngest client
│   ├── events.ts                  # Event type definitions
│   └── functions/
│       ├── index.ts               # Function registry
│       ├── process-shopify-order.ts
│       ├── process-refund.ts
│       ├── process-gps-fulfilment.ts
│       ├── process-stord-fulfilment.ts
│       └── process-order-cancellation.ts
└── lib/
    ├── config.ts                  # Environment config
    ├── clients/
    │   ├── dynamics.ts            # D365 THK API client
    │   ├── gps.ts                 # GPS API client
    │   └── shopify.ts             # Shopify API client
    ├── helpers/
    │   ├── country.ts             # ISO code conversion
    │   └── warehouse.ts           # Warehouse routing
    ├── mappings/
    │   ├── dynamics-sku.json      # SKU mappings
    │   └── warehouse-config.json  # Warehouse config
    ├── transformers/
    │   ├── address.ts             # Address formatting
    │   ├── order.ts               # Order transformation
    │   └── sku.ts                 # SKU transformation
    └── types/
        ├── dynamics.ts            # D365 types
        └── gps.ts                 # GPS types
```
