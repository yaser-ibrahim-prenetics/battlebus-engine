# Battle Bus Integration Test Flows

> 🚌 **Repository:** [github.com/Prenetics/battle-bus-simulation](https://github.com/Prenetics/battle-bus-simulation)

This directory contains comprehensive test documentation for all integration flows between:

- **Shopify** - E-commerce platform
- **Inngest** - Flow orchestration & state management
- **Dynamics 365** - ERP system
- **Extensiv** - 3PL/WMS
- **GPS** - 3PL warehouse

## 📋 Flow Overview

| #   | Flow                                                             | Direction                               | Document                                                                             |
| --- | ---------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | [Order Creation & Payment](#flow-1-order-creation--payment)      | Shopify → Inngest → Dynamics + WMS      | [01-order-creation-payment.md](./01-order-creation-payment.md)                       |
| 2   | [Extensiv Fulfillment](#flow-2-extensiv-fulfillment)             | Extensiv → Inngest → Shopify + Dynamics | [02-extensiv-fulfillment.md](./02-extensiv-fulfillment.md)                           |
| 3   | [GPS Fulfillment](#flow-3-gps-fulfillment)                       | Inngest ↔ GPS → Shopify + Dynamics      | [03-gps-fulfillment.md](./03-gps-fulfillment.md)                                     |
| 4   | [Dynamics Fulfillment](#flow-4-dynamics-fulfillment)             | Dynamics → Inngest → Shopify            | [04-dynamics-fulfillment-notification.md](./04-dynamics-fulfillment-notification.md) |
| 5   | [Refunds](#flow-5-refunds)                                       | Shopify → Inngest → Dynamics            | [05-refunds.md](./05-refunds.md)                                                     |
| 6   | [Cancellations](#flow-6-cancellations)                           | Shopify → Inngest (GPS exclusion)       | [06-cancellations.md](./06-cancellations.md)                                         |
| 7   | [Shopify Direct Fulfillment](#flow-7-shopify-direct-fulfillment) | Shopify → Inngest → Dynamics            | [07-shopify-direct-fulfillment.md](./07-shopify-direct-fulfillment.md)               |
| 8   | [Cancellation Orchestration](#flow-8-cancellation-orchestration) | Shopify/Hub → Inngest → GPS + Shopify   | [08-cancel-gps-and-uncancel.md](./08-cancel-gps-and-uncancel.md)                     |

> **Note:** Individual flow docs reference "spock-store" which is now handled by **Inngest flows**.

---

## 🏗️ Architecture Overview

```
                                    ┌─────────────┐
                                    │   Shopify   │
                                    │  (webhooks) │
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
              ▼                            ▼                            ▼
       orders/paid              orders/fulfilled              orders/cancelled
       refunds/create           orders/updated                refunds/create
              │                            │                            │
              └────────────────────────────┼────────────────────────────┘
                                           │
                                           ▼
                                   ┌─────────────┐
                                   │   Inngest   │
                                   │   (flows)   │
                                   └──────┬──────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
       ┌───────────┐              ┌─────────────┐              ┌───────────┐
       │ Dynamics  │              │   GPS 3PL   │              │  Extensiv │
       │    365    │              │  (polling)  │              │   (push)  │
       └───────────┘              └─────────────┘              └───────────┘
```

---

## 🚀 Quick Start

### 1. Start the Simulator

```bash
cd /path/to/simulation
npm install
npm run dev
```

Server runs on `http://localhost:3100`

### 2. Configure Inngest Flows

Point your Inngest flows to the simulator:

```json
{
  "shopify": { "baseUrl": "http://localhost:3100/shopify" },
  "dynamics": { "baseUrl": "http://localhost:3100/dynamics" },
  "gps": { "baseUrl": "http://localhost:3100/gps" }
}
```

### 3. Set Environment Variables

```bash
export TARGET_WEBHOOK_URL=http://localhost:8288  # Inngest dev server URL
export SHOPIFY_WEBHOOK_SECRET=your-secret
```

### 4. Run Test Flows

```bash
# US GPS order with fulfillment
npm run flow:order -- --template usGpsOrder --fulfill

# UK GPS order
npm run flow:order -- --template ukGpsOrder --fulfill --tracking royalMail

# Cancel order flow
npm run flow:order -- --template usGpsOrder --cancel

# Order with refund
npm run flow:order -- --template usGpsOrder --fulfill --refund
```

---

## 📑 Flow Summaries

### Flow 1: Order Creation & Payment

**Trigger:** Customer places order, Shopify fires `orders/paid` webhook

**Path:**

```
Shopify → Inngest → Dynamics (SalesOrder) → GPS/Extensiv (Outbound Order)
```

**Key Validations:**

- Dynamics `SalesOrderHeadersV3` created
- GPS `outboundOrder/create` called
- Internal `SalesOrder` entity created

[📄 Full Documentation](./01-order-creation-payment.md)

---

### Flow 2: Extensiv Fulfillment

**Trigger:** Extensiv ships order and sends webhook

**Path:**

```
Extensiv → Inngest → Shopify (fulfillment) → Dynamics (fulfilment)
```

**Key Validations:**

- Shopify fulfillment created with tracking
- Dynamics fulfillment notification sent
- Internal `Fulfilment` entity created

[📄 Full Documentation](./02-extensiv-fulfillment.md)

---

### Flow 3: GPS Fulfillment

**Trigger:** Scheduled Inngest task polls GPS for status updates

**Path:**

```
Inngest (poll) → GPS (status 3) → Inngest → Shopify + Dynamics
```

**Key Validations:**

- GPS order status = 3 (shipped)
- Tracking info retrieved
- Shopify fulfillment created
- Dynamics fulfillment notification sent

[📄 Full Documentation](./03-gps-fulfillment.md)

---

### Flow 4: Dynamics Fulfillment

**Trigger:** Dynamics pushes fulfillment/return notification

**Path:**

```
Dynamics → Inngest → Shopify (fulfillment)
```

**Key Validations:**

- Customer account validated
- SalesOrder matched by SO number
- Shopify fulfillment created

[📄 Full Documentation](./04-dynamics-fulfillment-notification.md)

---

### Flow 5: Refunds

**Trigger:** Customer/admin processes refund in Shopify

**Path:**

```
Shopify → Inngest → Dynamics (credit note)
```

**Key Validations:**

- Partial vs full refund handled
- Order status updated
- Not double-processed
- Doesn't interfere with GPS polling

[📄 Full Documentation](./05-refunds.md)

---

### Flow 6: Cancellations

**Trigger:** Order cancelled in Shopify

**Path:**

```
Shopify → Inngest → Dummy Fulfillment (GPS exclusion)
```

**Key Validations:**

- Order status = cancelled
- Dummy fulfillment ID created (`00000000000000`)
- Excluded from GPS polling
- Not re-processed

[📄 Full Documentation](./06-cancellations.md)

---

### Flow 7: Shopify Direct Fulfillment

**Trigger:** Manual fulfillment or external WMS (Stord) updates Shopify

**Path:**

```
Shopify → Inngest → Dynamics (fulfilment)
```

**Key Validations:**

- Fulfillment data extracted from webhook
- Internal `Fulfilment` entity created
- Dynamics fulfillment notification sent

[📄 Full Documentation](./07-shopify-direct-fulfillment.md)

---

### Flow 8: Cancellation Orchestration

**Trigger:** Cancellation from Shopify webhook or Battle Hub cancel action

**Path:**

```
Shopify/Hub → Inngest → GPS cancel (OMS) → Shopify uncancel safeguard (if shipped)
```

**Key Validations:**

- GPS cancel API called for GPS orders
- OMS async cancel status is polled to terminal state
- If GPS cancellation fails because shipped/in-flight, Shopify order is re-opened
- Canonical cancellation processing works from both Shopify and Hub entry points

[📄 Full Documentation](./08-cancel-gps-and-uncancel.md)

---

## 🧪 CLI Commands Reference

| Command                                      | Description                                 |
| -------------------------------------------- | ------------------------------------------- |
| `npm run flow:order -- --template <name>`    | Run order flow with template                |
| `npm run flow:order -- --fulfill`            | Include fulfillment in flow                 |
| `npm run flow:order -- --cancel`             | Include cancellation in flow                |
| `npm run flow:order -- --refund`             | Include refund in flow                      |
| `npm run flow:order -- --tracking <preset>`  | Use tracking preset (dhl, fedex, royalMail) |
| `npm run gps:fulfill -- --orderId <id>`      | Simulate GPS fulfillment                    |
| `npm run shopify:webhook -- --topic <topic>` | Send individual webhook                     |

### Order Templates

| Template         | Description                   | DataAreaId |
| ---------------- | ----------------------------- | ---------- |
| `usGpsOrder`     | US customer, GPS US warehouse | U001       |
| `ukGpsOrder`     | UK customer, GPS UK warehouse | H007       |
| `multiItemOrder` | Multiple line items           | U001       |
| `cancelledOrder` | For testing cancellation      | U001       |

### Tracking Presets

| Preset      | Carrier    | Example Number   |
| ----------- | ---------- | ---------------- |
| `dhl`       | DHL        | DHL1234567890    |
| `fedex`     | FedEx      | FEDEX9876543210  |
| `royalMail` | Royal Mail | RM123456789GB    |
| `gps`       | GPS        | GPS2024010112345 |

---

## 📊 State Management

### Check Order State

```bash
# List all orders
curl http://localhost:3100/state/orders

# Get specific order
curl http://localhost:3100/state/orders/IM8-1001

# Reset all state
curl -X DELETE http://localhost:3100/state/reset
```

### Order Status Flow

```
created → paid → processing → shipped → fulfilled
                     ↓
               cancelled → (dummy fulfillment)
                     ↓
               refunded
```

---

## 🔑 Key Concepts

### Dummy Fulfillment ID

```javascript
const CANCELLED_ORDER_FULFILMENT_ID = "00000000000000";
```

Used to mark cancelled orders and exclude them from GPS polling.

### DataAreaId

| Value  | Region | GPS Field      |
| ------ | ------ | -------------- |
| `U001` | US     | `gpsOrderId`   |
| `H007` | UK     | `gpsUKOrderId` |

### GPS Status Codes

| Status | Meaning                        |
| ------ | ------------------------------ |
| 0      | Created                        |
| 1      | Processing                     |
| 2      | Ready to Ship                  |
| 3      | Shipped (triggers fulfillment) |
| 4      | Delivered                      |

---

## 🔗 Related Resources

- [Simulator README](../../README.md)
- [Sample Orders Data](../../src/data/sample-orders.ts)
- [Shopify API Documentation](https://shopify.dev/docs/api)
- [Dynamics 365 OData](https://docs.microsoft.com/dynamics365/)

---

## 📝 Test Execution Checklist

Use this checklist when running comprehensive tests:

### Pre-Test Setup

- [ ] Simulator running on port 3100
- [ ] Inngest flows configured to use simulator
- [ ] Environment variables set
- [ ] Database/state reset (`DELETE /state/reset`)

### Flow 1: Order Creation

- [ ] Create US GPS order
- [ ] Create UK GPS order
- [ ] Verify Dynamics SO created
- [ ] Verify GPS order created

### Flow 2: Extensiv Fulfillment

- [ ] Setup order with Extensiv
- [ ] Send Extensiv webhook
- [ ] Verify Shopify fulfillment
- [ ] Verify Dynamics notification

### Flow 3: GPS Fulfillment

- [ ] Create order with GPS ID
- [ ] Simulate GPS status 3
- [ ] Verify Shopify fulfillment
- [ ] Verify Dynamics notification
- [ ] Verify not re-polled

### Flow 4: Dynamics Notification

- [ ] Send shipment notification
- [ ] Verify Shopify fulfillment
- [ ] Test return notification

### Flow 5: Refunds

- [ ] Full refund unfulfilled
- [ ] Full refund fulfilled
- [ ] Partial refund
- [ ] Verify status updates

### Flow 6: Cancellations

- [ ] Cancel before fulfillment
- [ ] Verify dummy fulfillment ID
- [ ] Verify GPS polling exclusion
- [ ] Test idempotency

### Flow 7: Shopify Direct

- [ ] Manual fulfillment
- [ ] Partial fulfillment
- [ ] Verify Dynamics notification
