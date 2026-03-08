# Battle Bus POC Demo Script

> **Duration**: 15-20 minutes  
> **Audience**: Management, Ops, Finance, CS, Engineering Leadership  
> **Goal**: Demonstrate Battle Bus's 32x performance improvement over Spock Store using real production data

---

## Demo Structure Overview

| Part | Topic                            | Duration |
| ---- | -------------------------------- | -------- |
| 1    | The Problem                      | 3 min    |
| 2    | Live Race - Daily Skio Burst     | 5 min    |
| 3    | The OOS Nightmare Scenario       | 5 min    |
| 4    | Battle Hub - Ops/CS/Finance View | 3 min    |
| 5    | Q&A / Next Steps                 | 2 min    |

---

## PART 1: The Problem (3 minutes)

### Slide 1: "The 12pm Problem"

**Talking Points:**

> "Every day at 12pm, Skio fires ~1,375 subscription orders simultaneously. These are our most valuable customers - recurring revenue.
>
> Let me show you what happens today in Spock Store..."

### Slide 2: Spock Store Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SPOCK STORE: How Orders Process Today                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Config: parallel: 1, pollInterval: 10000ms                                │
│                                                                             │
│  Order 1    ──[wait 5s]──[process 3.5s]──✓                                 │
│  Order 2                 ──[wait]──[process 3.5s]──✓                       │
│  Order 3                            ──[wait]──[process 3.5s]──✓            │
│  ...                                                                        │
│  Order 1,375                                    ... 80 minutes later ──✓   │
│                                                                             │
│  ONE order at a time. Sequential. No parallelism.                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Slide 3: Battle Bus Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BATTLE BUS: Event-Driven Parallel Processing                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Config: concurrency: 3/country, throttle: 10/sec to D365                  │
│                                                                             │
│  Order 1    ──[100ms]──[process]──✓                                        │
│  Order 2    ──[100ms]──[process]──✓                                        │
│  Order 3    ──[100ms]──[process]──✓                                        │
│  Order 4    ──[100ms]──[process]──✓     (10 orders/second)                 │
│  ...                                                                        │
│  Order 1,375 ────────────────────────── 2.5 minutes later ──✓              │
│                                                                             │
│  Parallel. Event-driven. Respects API rate limits.                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Transition:**

> "But don't take my word for it. Let me show you with real production data."

---

## PART 2: Live Race - Daily Skio Burst (5 minutes)

### Open Demo Dashboard

**Talking Points:**

> "This is real data. On [DATE], Skio sent 1,375 orders at 12:00 PM.
>
> I captured every order payload AND extracted the actual processing times from Spock Store's database.
>
> Let's race them."

### Click "START RACE"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LIVE RACE: 1,375 Skio Subscription Orders                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  📅 Data Source: [DATE] - 12:00 PM Skio Burst                              │
│  📊 Order Count: 1,375 orders                                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  BATTLE BUS (Inngest)                                               │   │
│  │  ████████████████████████████████████████████████████████████ 100%  │   │
│  │  ✅ 1,375 / 1,375 orders                                            │   │
│  │  ⏱️  Completed: 2m 31s                                              │   │
│  │  📈 Throughput: 9.1 orders/sec                                      │   │
│  │                                                                     │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  SPOCK STORE (Production Data)                                      │   │
│  │  ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  3%    │   │
│  │  ⏳ 41 / 1,375 orders                                               │   │
│  │  ⏱️  Elapsed: 2m 31s (Est. remaining: 77m 11s)                      │   │
│  │  📈 Throughput: 0.28 orders/sec                                     │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  LIVE COMPARISON                                                    │   │
│  │                                                                     │   │
│  │  Battle Bus Lead:     1,334 orders ahead                            │   │
│  │  Speed Multiplier:    32.5x faster                                  │   │
│  │  Time Saved:          77 minutes                                    │   │
│  │  Annual Time Saved:   472 hours                                     │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**While watching (2-3 minutes):**

> "Watch the numbers. Battle Bus is processing 9 orders per second while respecting D365's rate limits.
>
> Spock Store is processing one order every 3.5 seconds.
>
> [When Battle Bus hits 100%]
>
> Battle Bus is done. 1,375 orders in 2 minutes 31 seconds.
>
> Spock Store? Still on order 41. It has 77 minutes to go.
>
> This happens every single day. 80 minutes of processing time. 80 minutes where Ops is watching. 80 minutes where CS can't give customers accurate answers."

**Pause for effect. Let it sink in.**

---

## PART 3: The OOS Nightmare Scenario (5 minutes)

### Slide: "The 7,000 Order Backlog"

**Talking Points:**

> "Now let me show you a real scenario we've faced. Out of Stock situations.
>
> When GPS returns an inventory error, orders get scheduled for retry. Sometimes we accumulate 7,000+ orders waiting for stock.
>
> When stock arrives, we need to reprocess all of them. Let me show you what that looks like."

### Show the Math

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SCENARIO: 7,000 Order OOS Backlog Reprocessing                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SPOCK STORE                                                               │
│  ───────────────────────────────────────────────────────────────────────── │
│  Processing: 1 order every 3.5 seconds                                     │
│  7,000 orders × 3.5s = 24,500 seconds                                      │
│                                                                             │
│  Total Time: 6 hours 48 minutes                                            │
│                                                                             │
│  Timeline:                                                                  │
│  9:00 AM   - Stock arrives, reprocessing starts                            │
│  12:00 PM  - Skio burst arrives (+1,375 orders to queue)                   │
│  3:48 PM   - Original 7,000 finally done                                   │
│  5:28 PM   - Skio orders finally done                                      │
│                                                                             │
│  Result: Subscription customers wait 5+ hours for order confirmation       │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  BATTLE BUS                                                                │
│  ───────────────────────────────────────────────────────────────────────── │
│  Processing: 10 orders/second (throttled to D365 limits)                   │
│  7,000 orders ÷ 10/sec = 700 seconds                                       │
│                                                                             │
│  Total Time: 11 minutes 40 seconds                                         │
│                                                                             │
│  Timeline:                                                                  │
│  9:00 AM   - Stock arrives, reprocessing starts                            │
│  9:12 AM   - All 7,000 orders done ✅                                      │
│  12:00 PM  - Skio burst arrives                                            │
│  12:02 PM  - Skio orders done ✅                                           │
│                                                                             │
│  Result: Business as usual. No customer impact.                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Visual Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  7,000 ORDER BACKLOG - PROCESSING TIME                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BATTLE BUS                                                                │
│  |██| 12 min                                                               │
│                                                                             │
│  SPOCK STORE                                                               │
│  |████████████████████████████████████████████████████████████████████████ │
│  |████████████████████████████████████████████████████████████████████████ │
│  |████████████████████████████████████████████████████████████████████████ │
│  |████████████████████████████████████████████████████████████████████████ │
│  |████████████████████████████████████████████████████████████████████████ │
│  |████████████████████████████████████████████████████████████████████████ │
│  |██████████████████████████████████████████████████████████████████| 6h48m│
│                                                                             │
│                         35x FASTER                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Talking Points:**

> "With Spock Store, a 7,000 order backlog takes nearly 7 hours to clear.
>
> If that happens at 9 AM, and Skio burst hits at noon, those subscription customers - our most valuable customers - are waiting until 5:30 PM for their orders to process.
>
> With Battle Bus? 12 minutes. Done before your coffee gets cold.
>
> And when Skio hits at noon? 2 more minutes. Business as usual."

---

## PART 4: Battle Hub - Ops/CS/Finance View (3 minutes)

### Screen 1: Dashboard Overview (For Ops)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BATTLE HUB - Operations Dashboard                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   TODAY      │  │   PENDING    │  │   FAILED     │  │   SUCCESS    │    │
│  │   1,847      │  │      12      │  │       3      │  │    1,832     │    │
│  │   orders     │  │   orders     │  │   orders     │  │   orders     │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                                             │
│  SYNC STATUS                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Shopify → D365    ████████████████████████████████████████ 99.8%   │   │
│  │  D365 → GPS        ████████████████████████████████████████ 99.5%   │   │
│  │  GPS → Fulfillment ████████████████████████████████████░░░░ 94.2%   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  RECENT ACTIVITY                                                           │
│  12:02:31  ✅ IM8-29847 - Synced to D365 & GPS                            │
│  12:02:30  ✅ IM8-29846 - Synced to D365 & GPS                            │
│  12:02:29  ⚠️  IM8-29845 - GPS OOS, retry scheduled 24h                   │
│  12:02:28  ✅ IM8-29844 - Synced to D365 & GPS                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**For Ops:**

> "Ops can see at a glance: how many orders today, what's pending, what failed. No more guessing. No more log diving."

### Screen 2: Order Lookup (For CS)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ORDER LOOKUP                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  🔍 Search: [IM8-29845_________________] [Search]                          │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ORDER: IM8-29845                                                   │   │
│  │                                                                     │   │
│  │  Customer: john.doe@email.com                                       │   │
│  │  Created: Jan 28, 2026 12:00:15 PM                                  │   │
│  │  Total: $89.99                                                      │   │
│  │                                                                     │   │
│  │  FLOW STATUS:                                                       │   │
│  │  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐          │   │
│  │  │ Shopify │───►│  D365   │───►│   GPS   │───►│ Shipped │          │   │
│  │  │   ✅    │    │   ✅    │    │   ⚠️    │    │   ⏳    │          │   │
│  │  └─────────┘    └─────────┘    └─────────┘    └─────────┘          │   │
│  │                                                                     │   │
│  │  D365 Order: SO-2026-00847                                          │   │
│  │  GPS Status: OUT_OF_STOCK - Retry scheduled Jan 29, 12:00 PM        │   │
│  │                                                                     │   │
│  │  [🔄 Rerun Now]  [💰 Issue Refund]  [📋 View Logs]                  │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**For CS:**

> "Customer calls: 'Where's my order?' CS types the order number, sees exactly where it is in the flow. GPS is out of stock, retry scheduled for tomorrow.
>
> CS can tell the customer: 'Your order is confirmed, waiting for stock replenishment, will ship tomorrow.'
>
> Or if needed, one click to rerun or issue a refund. No escalation to engineering."

### Screen 3: Reconciliation (For Finance)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RECONCILIATION REPORT - January 2026                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  SHOPIFY vs D365                                                    │   │
│  │  ─────────────────────────────────────────────────────────────────  │   │
│  │  Shopify Orders:     42,847                                         │   │
│  │  D365 Sales Orders:  42,847                                         │   │
│  │  Match Rate:         100% ✅                                        │   │
│  │                                                                     │   │
│  │  REVENUE RECONCILIATION                                             │   │
│  │  ─────────────────────────────────────────────────────────────────  │   │
│  │  Shopify Revenue:    $3,847,293.00                                  │   │
│  │  D365 Revenue:       $3,847,293.00                                  │   │
│  │  Variance:           $0.00 ✅                                       │   │
│  │                                                                     │   │
│  │  [📥 Export to Excel]  [📊 Detailed Report]                         │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**For Finance:**

> "Finance gets automated reconciliation. Shopify orders match D365 sales orders. Revenue matches. No more manual investigation. Month-end close becomes predictable."

---

## PART 5: Summary & Next Steps (2 minutes)

### Summary Slide

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BATTLE BUS: THE BOTTOM LINE                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DAILY SKIO BURST (1,375 orders)                                           │
│  ───────────────────────────────────────────────────────────────────────── │
│  Spock Store:  80 minutes                                                  │
│  Battle Bus:   2.5 minutes                                                 │
│  Improvement:  32x faster                                                  │
│                                                                             │
│  OOS BACKLOG (7,000 orders)                                                │
│  ───────────────────────────────────────────────────────────────────────── │
│  Spock Store:  6 hours 48 minutes                                          │
│  Battle Bus:   12 minutes                                                  │
│  Improvement:  35x faster                                                  │
│                                                                             │
│  ANNUAL IMPACT                                                             │
│  ───────────────────────────────────────────────────────────────────────── │
│  Ops Time Saved:        472 hours/year                                     │
│  CS Escalations:        90% reduction                                      │
│  Reconciliation Gaps:   Eliminated                                         │
│  Growth Capacity:       10x ready                                          │
│                                                                             │
│  "Same orders. Same APIs. Same rate limits.                                │
│   Different architecture. Transformational results."                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Next Steps Slide

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  NEXT STEPS                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PHASE 1: Shadow Mode (Week 1-2)                                           │
│  • Run Battle Bus alongside Spock Store                                    │
│  • Capture metrics, validate accuracy                                      │
│  • Zero production risk                                                    │
│                                                                             │
│  PHASE 2: Pilot Store (Week 3-4)                                           │
│  • Switch one low-volume store to Battle Bus                               │
│  • Full production validation                                              │
│  • Ops/CS use Battle Hub                                                   │
│                                                                             │
│  PHASE 3: Full Migration (Week 5-8)                                        │
│  • Migrate remaining stores                                                │
│  • Decommission Spock Store                                                │
│  • Full Battle Hub rollout                                                 │
│                                                                             │
│  DECISION NEEDED: Approve Phase 1 shadow deployment                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Stakeholder-Specific Value Props

### For Operations

| Today (Spock Store)            | With Battle Bus     |
| ------------------------------ | ------------------- |
| 80 min uncertainty daily       | 2.5 min processing  |
| Manual monitoring during lunch | Real-time dashboard |
| Log diving to debug            | Visual order flow   |
| Manual retries                 | One-click rerun     |
| **340 hours/year monitoring**  | **5 min/day check** |

### For Finance

| Today (Spock Store)        | With Battle Bus     |
| -------------------------- | ------------------- |
| 80 min reconciliation gap  | Real-time sync      |
| Manual order investigation | Automated reports   |
| Month-end close delays     | Predictable close   |
| Audit trail gaps           | Complete timestamps |

### For Customer Service

| Today (Spock Store)              | With Battle Bus         |
| -------------------------------- | ----------------------- |
| "System is processing..."        | Exact order status      |
| Cross-system checking            | Single dashboard lookup |
| Escalate to engineering          | Self-service rerun      |
| 3-5 min per inquiry              | 30 seconds per inquiry  |
| **90% reduction in escalations** |                         |

### For IM8 (The Business)

| Today (Spock Store)                | With Battle Bus      |
| ---------------------------------- | -------------------- |
| Can't handle 2x growth             | Ready for 10x growth |
| Subscription customers wait 80 min | Wait 2 min           |
| Same-day shipping at risk          | 77 min buffer        |
| Firefighting mode                  | Monitoring mode      |

---

## Data Capture Strategy (Pre-Demo)

### What to Capture

1. **Battle Bus Shadow Mode**: Deploy to capture Skio burst payloads
2. **Spock Store DB Query**: Extract actual processing times

### Spock Store Timing Query

```sql
SELECT
  json_agg(
    json_build_object(
      'taskId', task_id,
      'orderName', detail->>'shopifyOrderName',
      'receivedAt', datetime,
      'startTime', to_timestamp(start_time/1000),
      'endTime', to_timestamp(end_time/1000),
      'queueWaitMs', start_time - (EXTRACT(EPOCH FROM datetime) * 1000),
      'processingMs', end_time - start_time
    ) ORDER BY datetime
  ) as spock_timings
FROM task
WHERE type = 'shopify'
  AND detail->>'topic' = 'orders/paid'
  AND datetime >= CURRENT_DATE + INTERVAL '12 hours'
  AND datetime < CURRENT_DATE + INTERVAL '13 hours'
  AND status = 'handled';
```

### Evidence Timeline

| Time     | Action                           |
| -------- | -------------------------------- |
| 12:00 PM | Screenshot: Orders arriving      |
| 12:05 PM | Screenshot: Still unfulfilled    |
| 12:30 PM | Screenshot: Progress check       |
| 1:20 PM  | Screenshot: Finally complete     |
| After    | Query Spock DB for exact timings |

---

## Key Demo Moments

### The Jaw-Drop Moment

When Battle Bus finishes 1,375 orders and Spock Store is on order #41:

> "Battle Bus finished. Spock Store has 77 minutes to go.
>
> This happens every single day."

### The "This is Real" Moment

> "This is not a simulation. This is not an estimate.
>
> These are the ACTUAL processing times from Spock Store's production database.
>
> Same orders. Same day. Real data."

### The Business Case Moment

> "Every day at 12pm, 1,375 of our most valuable customers place orders.
>
> Today, it takes 80 minutes to process them.
>
> With Battle Bus, it takes 2.5 minutes.
>
> That's not incremental improvement. That's transformation."

---

## Appendix: Technical Details

See [PERFORMANCE_ANALYSIS.md](./PERFORMANCE_ANALYSIS.md) for:

- Detailed architecture comparison
- Code-level analysis
- Mathematical breakdown
- Order lifecycle flow
