# Simple Architecture Diagram

This is the easiest way to understand the system.

## High-Level View

```mermaid
flowchart LR
    A[Shopify<br/>Orders + Webhooks] --> B[Battle Bus<br/>Inngest Functions]
    B --> C[D365<br/>ERP]
    B --> D[GPS / 3PL<br/>Warehouse]
    B --> E[Supabase<br/>Order State]
    E --> F[Battle Hub<br/>Ops Dashboard]
    B --> F
```

## What Each Part Does

- `Shopify`: sends order events like create, paid, cancel, refund.
- `Battle Bus (Inngest)`: processes each event step-by-step with retries.
- `D365`: receives sales orders and financial updates.
- `GPS / 3PL`: receives fulfillment orders and returns shipment updates.
- `Supabase`: stores order status, errors, and processing history.
- `Battle Hub`: where Ops/CS sees status, backorders, and retries orders.

## 1-Minute Flow

```mermaid
sequenceDiagram
    participant S as Shopify
    participant B as Battle Bus (Inngest)
    participant D as D365
    participant G as GPS/3PL
    participant DB as Supabase
    participant H as Battle Hub

    S->>B: Webhook (order/paid)
    B->>D: Create sales order
    B->>G: Create fulfillment order
    B->>DB: Save latest status + steps
    DB-->>H: Realtime updates
    B-->>H: Extra run/step updates
```

## Mental Model

- **Battle Bus = engine**
- **Battle Hub = control panel**
