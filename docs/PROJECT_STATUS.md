# Battle Bus Project Status & Completion Checklist

## Overview

This document tracks what has been scaffolded in Battle Bus and what needs to be extracted from spock-store to complete the migration.

---

## Phase 1: Foundation (COMPLETE)

### 1.1 Project Setup
- [x] Next.js 16 with App Router
- [x] TypeScript configuration
- [x] Inngest SDK integration
- [x] Tailwind CSS (for any UI needs)
- [x] ESLint configuration

### 1.2 Inngest Infrastructure
- [x] `src/inngest/client.ts` - Inngest client with app ID
- [x] `src/inngest/events.ts` - Event type definitions (4 events)
- [x] `src/inngest/functions/index.ts` - Function registry
- [x] `src/app/api/inngest/route.ts` - Inngest API handler

### 1.3 Webhook Endpoints
- [x] `src/app/api/webhooks/shopify/route.ts` - Shopify orders & refunds
- [x] `src/app/api/webhooks/gps/route.ts` - GPS fulfilment notifications
- [x] `src/app/api/webhooks/stord/route.ts` - STORD fulfilment notifications

### 1.4 Configuration
- [x] `src/lib/config.ts` - Environment-based configuration
- [x] Feature flags (DRY_RUN_MODE, ENABLE_*_SYNC)
- [x] Retry configuration
- [x] Delay configuration (OOS retry hours)

---

## Phase 2: Inngest Functions (SCAFFOLDED - NEEDS COMPLETION)

### 2.1 process-shopify-order
**Status:** Scaffolded with step.run() structure

| Step | Battle Bus | Spock-Store Source | Status |
|------|------------|-------------------|--------|
| Check existing D365 order | ✅ Implemented | `repository/salesorder.ts` | Done |
| Create D365 header | ⚠️ Basic | `integration/dynamics.ts` → `createSalesOrderHeadersV3()` | Needs THK fields |
| Create D365 lines | ⚠️ Basic | `integration/dynamics.ts` → `createSalesOrderLine()` | Needs SKU mapping |
| Confirm D365 order | ⚠️ Basic | `integration/dynamics.ts` → `confirm()` | Needs THK API |
| Create prepayment | ⚠️ Basic | `integration/dynamics.ts` → `createPostPrepayment()` | Needs THK API |
| Send to GPS | ⚠️ Basic | `integration/gps.ts` → `createOutboundOrder()` | Needs auth code |
| OOS retry logic | ✅ Implemented | N/A (new feature) | Done |

**Missing from spock-store:**
- [ ] Gift card handling (`component/giftcard.ts`)
- [ ] Discount allocation (`component/price.ts`)
- [ ] Shipping cost calculation (`component/shipping.ts`)
- [ ] Tax calculation (`component/tax.ts`)
- [ ] Rewards/subscription logic (`component/rewards.ts`)
- [ ] Split fulfilment logic (`component/split.ts`)
- [ ] Order type detection (`component/ordertype.ts`)

### 2.2 process-refund
**Status:** Scaffolded - needs D365 credit note implementation

| Step | Battle Bus | Spock-Store Source | Status |
|------|------------|-------------------|--------|
| Get D365 order | ✅ Implemented | `repository/salesorder.ts` | Done |
| Create credit note | ❌ TODO | `integration/dynamics.ts` | Not implemented |

**Missing from spock-store:**
- [ ] Credit note creation logic
- [ ] Refund amount calculation

### 2.3 process-gps-fulfilment
**Status:** Scaffolded with basic flow

| Step | Battle Bus | Spock-Store Source | Status |
|------|------------|-------------------|--------|
| Get Shopify order | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| Get fulfilment orders | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| Create Shopify fulfilment | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| Create D365 packing slip | ⚠️ Basic | `integration/dynamics.ts` → `createFulfilment()` | Needs full impl |

**Missing from spock-store:**
- [ ] Tracking info mapping (`component/tracking.ts`)
- [ ] Carrier code mapping
- [ ] D365 fulfilment with proper line mapping

### 2.4 process-stord-fulfilment
**Status:** Scaffolded (mirrors GPS flow)

Same gaps as GPS fulfilment.

---

## Phase 3: API Clients (PARTIAL)

### 3.1 Dynamics 365 Client
**File:** `src/lib/clients/dynamics.ts`

| Function | Battle Bus | Spock-Store | Status |
|----------|------------|-------------|--------|
| `authenticate()` | ✅ OAuth2 | `integration/authentication.ts` | Done |
| `createSalesOrderHeader()` | ⚠️ V2 API | `createSalesOrderHeadersV3()` | **Needs V3 + THK fields** |
| `createSalesOrderLine()` | ⚠️ Basic | Full implementation | **Needs CircleDNA logic** |
| `confirmSalesOrder()` | ⚠️ OData | THK API endpoint | **Needs THK API** |
| `createPrepayment()` | ⚠️ OData | THK API endpoint | **Needs THK API** |
| `createFulfilment()` | ⚠️ OData | THK API endpoint | **Needs THK API** |
| `getSalesOrderByShopifyId()` | ✅ Implemented | Repository query | Done |
| `createCreditNote()` | ❌ Missing | Not in spock-store | Need to add |
| `createReturnOrder()` | ❌ Missing | `createSalesOrderHeadersV3ForReturn()` | Need to add |

**Key difference:** Spock-store uses THK custom API endpoints, not standard OData.

### 3.2 GPS Client
**File:** `src/lib/clients/gps.ts`

| Function | Battle Bus | Spock-Store | Status |
|----------|------------|-------------|--------|
| `generateSignature()` | ⚠️ Basic HMAC | `generateAuthCode()` with sorted keys | **Needs fix** |
| `createOutboundOrder()` | ⚠️ Basic | Full implementation | **Needs proper payload** |
| `getOrderStatus()` | ✅ Implemented | `getOutboundOrdersDetails()` | Done |
| `cancelOutboundOrder()` | ✅ Implemented | N/A | Done |
| `verifyWebhookSignature()` | ✅ Implemented | N/A | Done |

**Key difference:** GPS auth uses `authcode` query param with specific key sorting.

### 3.3 Shopify Client
**File:** `src/lib/clients/shopify.ts`

| Function | Battle Bus | Spock-Store | Status |
|----------|------------|-------------|--------|
| `getOrder()` | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| `getFulfillmentOrders()` | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| `createFulfillment()` | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| `getOrderTransactions()` | ✅ Implemented | `integration/shopify/restful.ts` | Done |
| `verifyWebhookSignature()` | ✅ Implemented | N/A | Done |

**Status:** Mostly complete.

### 3.4 STORD Client
**File:** `src/lib/clients/stord.ts`

| Function | Battle Bus | Spock-Store | Status |
|----------|------------|-------------|--------|
| All functions | ❌ Missing | N/A (uses Extensiv) | **Need to create** |

---

## Phase 4: Transformers & Business Logic (PARTIAL)

### 4.1 Order Transformer
**File:** `src/lib/transformers/order.ts`

| Function | Battle Bus | Spock-Store Source | Status |
|----------|------------|-------------------|--------|
| `toD365SalesOrderHeader()` | ⚠️ Basic | `component/salesorder.ts` | Needs THK fields |
| `toD365SalesOrderLine()` | ⚠️ Basic | `component/salesorder.ts` | Needs SKU mapping |
| `toGpsOutboundOrder()` | ⚠️ Basic | `component/salesorder.ts` | Needs proper payload |
| `calculatePrepaymentAmount()` | ✅ Implemented | `component/salesorder.ts` | Done |
| `shouldSendToGps()` | ✅ Implemented | `component/warehouse.ts` | Done |

### 4.2 Missing Transformers (Need to Create)

| File to Create | Spock-Store Source | Purpose |
|----------------|-------------------|---------|
| `src/lib/transformers/address.ts` | `component/address.ts` | Address formatting |
| `src/lib/transformers/sku.ts` | `component/inventory.ts` | SKU mapping logic |
| `src/lib/transformers/fulfilment.ts` | `component/fulfilment.ts` | Fulfilment mapping |
| `src/lib/transformers/tracking.ts` | `component/tracking.ts` | Tracking URL generation |

---

## Phase 5: SKU Mappings (NOT STARTED)

### 5.1 Required Mapping Files

| File to Create | Spock-Store Source | Purpose |
|----------------|-------------------|---------|
| `src/lib/mappings/dynamics-sku.json` | `resource/dynamics/sku.json` | Refill, Reward, Merge SKUs |
| `src/lib/mappings/extensiv-sku.json` | `resource/extensiv/sku.json` | Extensiv → D365 mapping |

### 5.2 SKU Mapping Structure (from spock-store)

```json
{
  "refill": {
    "IM8-FG-000010": "IM8-FG-000035",
    "IM8-FG-000030": "IM8-FG-000053"
  },
  "reward": {
    "3": "IM8-FG-000022"
  },
  "merge": {
    "IM8-FG-000076": "IM8-FG-000010",
    "IM8-FG-000078": "IM8-FG-000011"
  }
}
```

---

## Phase 6: Warehouse Routing (NOT STARTED)

### 6.1 Required Logic

| Component | Spock-Store Source | Purpose |
|-----------|-------------------|---------|
| Warehouse detection | `component/warehouse.ts` | GPS vs GPS UK vs STORD |
| Data area mapping | `resource/api.json` | dataAreaId per warehouse |
| Shipping routing | `component/shipping.ts` | Carrier selection |

### 6.2 Warehouse Configuration (from spock-store api.json)

```
GPS Warehouse → dataAreaId: U001
GPS UK Warehouse → dataAreaId: H007
Extensiv → dataAreaId: varies
```

---

## Phase 7: Helper Functions (NOT STARTED)

### 7.1 Functions to Port

| Function | Spock-Store Source | Purpose |
|----------|-------------------|---------|
| `calculateDiscountAllocations()` | `component/price.ts` | Discount per line |
| `calculateShippingCost()` | `component/shipping.ts` | Shipping line creation |
| `calculateTax()` | `component/tax.ts` | Tax line creation |
| `getRewards()` | `component/rewards.ts` | Subscription rewards |
| `getGiftCardApplication()` | `component/giftcard.ts` | Gift card handling |
| `filterDummySku()` | `component/filterline.ts` | Remove dummy SKUs |
| `isTestOrder()` | `component/salesorder.ts` | Test order detection |
| `getCountryISO3()` | `component/countrycode.ts` | Country code conversion |
| `getTrackingInfo()` | `component/tracking.ts` | Tracking URL generation |

---

## Completion Checklist

### Must Have (MVP)
- [ ] Port SKU mappings from spock-store
- [ ] Update D365 client to use THK API endpoints
- [ ] Fix GPS auth code generation (sorted keys)
- [ ] Port address transformer with UAE/SA handling
- [ ] Add shipping/tax line creation
- [ ] Test end-to-end with dry run mode

### Should Have
- [ ] Port gift card handling
- [ ] Port discount allocation
- [ ] Port rewards logic
- [ ] Add warehouse routing (GPS vs GPS UK)
- [ ] Create STORD client

### Nice to Have
- [ ] Daily reconciliation cron job
- [ ] Slack notifications
- [ ] PayPal tracking integration

---

## File-by-File Extraction Guide

### Priority 1: Copy Directly
```
spock-store/src/resource/dynamics/sku.json → battle-bus/src/lib/mappings/dynamics-sku.json
spock-store/src/resource/extensiv/sku.json → battle-bus/src/lib/mappings/extensiv-sku.json
```

### Priority 2: Port with Modifications
```
spock-store/src/component/address.ts → battle-bus/src/lib/transformers/address.ts
spock-store/src/component/tracking.ts → battle-bus/src/lib/transformers/tracking.ts
spock-store/src/component/inventory.ts → battle-bus/src/lib/transformers/sku.ts
```

### Priority 3: Extract Functions
```
From spock-store/src/component/integration/dynamics.ts:
  - createSalesOrderHeadersV3() → Update battle-bus/src/lib/clients/dynamics.ts
  - confirm() → Update battle-bus/src/lib/clients/dynamics.ts
  - createPostPrepayment() → Update battle-bus/src/lib/clients/dynamics.ts
  - createFulfilment() → Update battle-bus/src/lib/clients/dynamics.ts

From spock-store/src/component/integration/gps.ts:
  - generateAuthCode() → Update battle-bus/src/lib/clients/gps.ts
  - createOutboundOrder() → Update battle-bus/src/lib/clients/gps.ts
```

### Priority 4: Port Business Logic
```
From spock-store/src/component/salesorder.ts:
  - toSalesOrderLines() → battle-bus/src/lib/transformers/order.ts
  - getDynamicsSalesOrderHeaderComment() → battle-bus/src/lib/transformers/order.ts

From spock-store/src/component/shipping.ts:
  - calculateShippingCost() → battle-bus/src/lib/helpers/shipping.ts
  - getUsWareshouseRoutingInfo() → battle-bus/src/lib/helpers/shipping.ts

From spock-store/src/component/tax.ts:
  - calculateTax() → battle-bus/src/lib/helpers/tax.ts
```

---

## Testing Checklist

### Local Testing
- [ ] Webhook endpoint receives Shopify order
- [ ] Event sent to Inngest
- [ ] Function executes with dry run
- [ ] All steps complete without error

### Integration Testing
- [ ] D365 order creation (with real credentials)
- [ ] GPS order submission (with real credentials)
- [ ] Shopify fulfilment creation
- [ ] Idempotency (same order twice)
- [ ] OOS retry (mock GPS error)

### Production Readiness
- [ ] Environment variables documented
- [ ] Vercel deployment working
- [ ] Inngest cloud connected
- [ ] Webhook secrets configured
- [ ] Monitoring/alerting set up
