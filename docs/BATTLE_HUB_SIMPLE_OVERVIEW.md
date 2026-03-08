# Battle Hub - Simple Overview

> **What is Battle Hub?** A dashboard that lets Ops, Finance, and CS manage orders without needing to ask Engineering for help.

---

## The Problem (What We're Fixing)

Every day, our Slack channels are filled with messages like:

| Message                           | Who Says It | How Often           |
| --------------------------------- | ----------- | ------------------- |
| "Can we rerun the sync?"          | Marco, Ops  | Weekly              |
| "Please investigate this order"   | CS, Ops     | Daily               |
| "Pls help replenish these SKUs"   | Leon, Ops   | Multiple times/week |
| "4000 orders still not fulfilled" | Leon        | When things break   |
| "Can you check this order?"       | CS          | Daily               |

**The current system (Spock Store) can't handle order bursts and requires constant manual intervention.**

---

## The Solution (What Battle Hub Does)

### For Ops Team

| Problem                               | Battle Hub Solution                                            |
| ------------------------------------- | -------------------------------------------------------------- |
| Orders get stuck, no one knows        | **Order Lifecycle Tracker** - See exactly where every order is |
| Need to manually replay failed orders | **Bulk Operations** - One-click retry for hundreds of orders   |
| Out-of-stock orders need manual retry | **OOS Auto-Retry** - System automatically retries daily        |
| No warning before inventory runs out  | **Inventory Alerts** - Slack notification when stock is low    |

### For CS Team

| Problem                                        | Battle Hub Solution                                    |
| ---------------------------------------------- | ------------------------------------------------------ |
| "Where is my order?" - need to ask Engineering | **Order Lookup** - Search any order, see full status   |
| Can't see if order is stuck                    | **Lifecycle View** - Visual pipeline showing each step |

### For Finance Team

| Problem                                       | Battle Hub Solution                                 |
| --------------------------------------------- | --------------------------------------------------- |
| Manual reconciliation between systems         | **Auto Reports** - Daily/weekly/monthly CSV exports |
| Order counts don't match between Shopify/D365 | **Discrepancy Detection** - Automatic alerts        |

### For Management

| Problem                                        | Battle Hub Solution                                            |
| ---------------------------------------------- | -------------------------------------------------------------- |
| No visibility into system health               | **Dashboard** - Real-time stats on all integrations            |
| Don't know about problems until Slack explodes | **Proactive Alerts** - Know about issues before they're crises |

---

## The 10 Features We're Building

### 🔴 Critical (Must Have for POC)

1. **Demo Replay** - Prove Battle Bus is faster by replaying real orders
2. **Order Lifecycle Tracker** - See where every order is in the pipeline
3. **Bulk Operations Center** - Retry/resync hundreds of orders at once
4. **OOS Auto-Retry Queue** - Automatic retry for out-of-stock orders

### 🟡 High Priority

5. **Inventory Health Dashboard** - Monitor stock across all warehouses
6. **Fulfillment Sync Monitor** - Track GPS → D365 → Shopify sync
7. **Real-Time Alerts** - Slack notifications for problems

### 🟢 Nice to Have

8. **CS Order Lookup** - Self-service order search for CS team
9. **System Health Dashboard** - Integration status at a glance
10. **Finance Reconciliation** - Automated reports

---

## How It Works (Simple Version)

### Before (Spock Store)

```
Order comes in
    ↓
Wait 10 seconds (polling)
    ↓
Process 1 order
    ↓
Wait 10 seconds
    ↓
Process next order
    ↓
... repeat forever ...

1,000 orders = 2+ hours
```

### After (Battle Bus + Hub)

```
Order comes in
    ↓
Process immediately (webhook)
    ↓
Process 10 orders at same time (concurrent)
    ↓
Track every step (lifecycle)
    ↓
Auto-retry if failed (OOS queue)
    ↓
Alert if stuck (Slack)

1,000 orders = 2 minutes
```

---

## The Dashboard Pages

### 1. Home Dashboard

- System health status (green/yellow/red)
- Orders processed today
- Current queue depth
- Active alerts

### 2. Orders Page

- Search any order by ID or name
- See full lifecycle (Shopify → D365 → GPS → Fulfilled)
- Retry failed orders
- View detailed logs

### 3. Bulk Operations

- Filter orders by date, status, warehouse
- Preview what will be affected
- One-click retry/resync
- Track progress in real-time

### 4. OOS Queue

- Orders waiting for stock
- Automatic retry schedule
- Manual "retry now" option
- Stats on resolution time

### 5. Inventory

- Stock levels across all systems
- Discrepancy alerts
- Manual sync buttons
- Threshold configuration

### 6. Alerts

- Configure what triggers alerts
- Set Slack channels
- View alert history
- Snooze/acknowledge

### 7. Reports (Finance)

- Daily reconciliation
- Order counts by system
- Revenue comparison
- CSV export

### 8. Demo (POC only)

- Load historical orders
- Race Battle Bus vs Spock Store
- Show real-time progress
- Prove the speed difference

---

## Timeline

| Day         | What We Build                               |
| ----------- | ------------------------------------------- |
| **Day 1-2** | Demo page, Order lifecycle, Basic dashboard |
| **Day 3-4** | Bulk operations, OOS queue, Slack alerts    |
| **Day 5**   | Inventory dashboard, Fulfillment monitor    |
| **Week 2**  | Finance reports, Polish, Testing            |

---

## The POC Demo (What We Show Management)

### The Setup

1. Load 1,847 real orders from January 8th incident
2. Show how long Spock Store took (3 hours 35 minutes)
3. Run same orders through Battle Bus

### The Result

```
┌─────────────────────────────────────────┐
│  SPOCK STORE        │  BATTLE BUS      │
│  3h 35m             │  3m 05s          │
│                     │                  │
│  Sequential         │  Concurrent      │
│  Manual retries     │  Auto retries    │
│  No visibility      │  Full dashboard  │
└─────────────────────────────────────────┘

IMPROVEMENT: 69x FASTER
```

### The Message

> "Same orders. Same data. 69x faster. Plus a dashboard so Ops never has to ask Engineering to 'rerun the sync' again."

---

## Key Differences from Spock Store

| Aspect              | Spock Store                    | Battle Hub                  |
| ------------------- | ------------------------------ | --------------------------- |
| **Speed**           | 1 order at a time              | 10+ orders at a time        |
| **Visibility**      | Check database manually        | Visual dashboard            |
| **Retries**         | Manual Slack request           | Automatic                   |
| **Alerts**          | None (find out when it breaks) | Proactive Slack alerts      |
| **Self-service**    | Need Engineering               | Ops/CS can do it themselves |
| **OOS handling**    | Manual replay next day         | Auto-retry with queue       |
| **Bulk operations** | Run SQL queries                | One-click in UI             |

---

## Success = No More Slack Messages Like These

- ❌ "Can we rerun the sync?"
- ❌ "Please investigate this order"
- ❌ "4000 orders still not fulfilled"
- ❌ "Order created Dec 18 just synced Jan 2"
- ❌ "Pls help replenish these SKUs"

**Instead:**

- ✅ Ops clicks "Retry All" in Battle Hub
- ✅ CS searches order in Order Lookup
- ✅ System auto-retries OOS orders
- ✅ Slack alert warns before stockout

---

## Questions?

This document is the simple version. For full technical specs, see:

- `BATTLE_HUB_POC_ROADMAP.md` - Complete feature specifications
- `PERFORMANCE_ANALYSIS.md` - Why Battle Bus is faster
- `POC_DEMO_SCRIPT.md` - Full demo presentation script

---

_Built with Vercel + Inngest + Shadcn/ui. Designed to eliminate operational pain points forever._
