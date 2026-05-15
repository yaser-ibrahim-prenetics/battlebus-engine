# Flow verification checklist

Use this document when smoke-testing or releasing changes that touch order lifecycle integrations. It complements the detailed flow write-ups under [`flows/`](./flows/README.md).

**Systems**

| System | Role |
|--------|------|
| **Shopify** | Source of truth for commercial state; webhooks into Battle Bus |
| **Dynamics 365 (D365)** | ERP: sales orders, lines, packing slips / fulfilment postings |
| **GPS (US / UK)** | 3PL WMS: outbound order create; ship status |
| **Stord** | 3PL: fulfilment often via Shopify → D365 packing slip (HK / EU / ATL routing) |

---

## Where to look (operators)

| Where | What you get |
|-------|----------------|
| **Battle Hub** | Order row, D365 SO number, GPS ids, flow log timeline, errors |
| **D365** | OData entities below + Finance and Operations UI (sales orders, lines, inventory) |
| **Shopify Admin** | Order payment, fulfillments, refunds, cancel state |
| **GPS / Stord** | 3PL portal or support for outbound id and ship status |

**Inngest (reference only)** — most operators do not have console access. If engineering needs a second opinion: Inngest dashboard → function run for the Shopify order / event payload. Not required for day-to-day verification if Hub + D365 + Shopify already match.

---

## Dynamics 365: entities to verify

These are the **Finance & Operations** (D365) surfaces and **OData** entities the integration touches. Locate the order by **`THK_ShopifyReference`** (Shopify order GID or configured ref) or by **Sales order number** copied from Hub.

| Area | Primary entities / actions | What to confirm |
|------|----------------------------|-----------------|
| **Sales order (create)** | **`SalesOrderHeadersV3`** | Header exists; status confirmed; `SalesOrderNumber`; `THK_ShopifyReference` matches Shopify order |
| **Sales lines (create)** | **`SalesOrderLines`** | One row per sellable line; qty and **item numbers** match expectation |
| **Financial** | Prepayment service (via integration) | Posted when order has customer payment (see [D365_FLOWS_AND_STEPS](./D365_FLOWS_AND_STEPS.md)) |
| **Ship / fulfil (packing slip)** | Custom **`fulfilment`** service → packing slip | Posted fulfilment / packing slip for shipped qty (GPS cron path vs Shopify-fulfilled path) |
| **Refund** | **`SalesOrderHeadersV3`** + **`SalesOrderLines`** | Refund handling adds **negative-qty** line(s) with **refund SKU** from warehouse config; **return fulfilment** path per tenant (see [05-refunds](./flows/05-refunds.md)); no duplicate line for same refund |
| **Cancel / return (D365)** | **`SalesOrderHeadersV3`** + **`SalesOrderLines`** | When GPS cannot cancel (e.g. already shipped), a **return** header/lines may be created — confirm in D365 UI per [Flow 4](./D365_FLOWS_AND_STEPS.md) |
| **Dynamics → Shopify ship** | N/A in D365 UI | Webhook carries `salesOrderNumber`, `dataAreaId`; ERP is source — confirm Shopify fulfillment after posting |

**Useful OData filters (engineering / support):**

- Header by Shopify ref: `GET /data/SalesOrderHeadersV3?$filter=THK_ShopifyReference eq '<shopify-order-id>'`
- Lines by SO: `GET /data/SalesOrderLines?$filter=SalesOrderNumber eq '<SO-Number>'`

(Exact host, company, and auth are environment-specific.)

---

## Warehouse & company (DataAreaId)

Routing maps Shopify location / line metadata to a **warehouse** and D365 **data area** (company). Use the order’s **Hub warehouse** (or Shopify location) to know which D365 company to open.

| Typical route | Hub / Shopify signal | D365 **DataAreaId** (reference) | Warehouse / 3PL to verify |
|---------------|----------------------|----------------------------------|---------------------------|
| **GPS United States** | US GPS-eligible location | **`U001`** (simulator / common US) | GPS US — outbound id on order (`gps_order_no` / US id) |
| **GPS United Kingdom** | UK GPS-eligible location | **`H007`** (simulator / common UK) | GPS UK — UK outbound id (`gps_uk_order_no` / GB warehouse code, e.g. GB03RS in config) |
| **Stord / HK / EU** | Non-GPS or Stord-routed | Per tenant (**often still U001 / H007 / HK** — confirm in `api.json` / warehouse config) | **Stord** or HK fulfilment; **no** GPS outbound (unless mis-routed) |
| **Stord ATL** | ATL-served SKUs / location | Per tenant config | Stord ATL — refund SKU may differ (`IM8-SER-000005` vs EU in refund doc) |

Always confirm **DataAreaId** and **inventory site / warehouse** on the **sales order lines** in D365 for the test order; simulator templates use **`U001`** for US GPS and **`H007`** for UK GPS ([flows/README.md](./flows/README.md#order-templates)).

---

## 1. Order creation → downstream

**Typical trigger:** Shopify paid order → D365 sales order + lines → optional GPS outbound.

### 1.1 Always check (no Inngest UI required)

- [ ] **Shopify:** order paid; tags / location as expected  
- [ ] **Hub:** order shows expected **warehouse**; **D365 SO number** when synced  
- [ ] **D365:** **`SalesOrderHeadersV3`** (+ **`SalesOrderLines`**) in the correct **DataAreaId** (see table above)  
- [ ] **D365:** **`THK_ShopifyReference`** on header matches the Shopify order you are testing  

### 1.2 By fulfilment channel

| Channel | 3PL / WMS checks | D365 + company |
|---------|------------------|----------------|
| **GPS US** | [ ] GPS outbound created (US); id on Hub order | [ ] SO under **`U001`** (or tenant US company) |
| **GPS UK** | [ ] GPS outbound created (UK); UK id on Hub order | [ ] SO under **`H007`** (or tenant UK company) |
| **Stord / non-GPS** | [ ] No GPS ids if route is Stord-only | [ ] SO lines site/warehouse match Stord/HK routing |

### 1.3 Edge cases

- [ ] Duplicate paid / replay: **one** D365 SO per Shopify order (re-query `SalesOrderHeadersV3` by `THK_ShopifyReference`)  
- [ ] **Backorder / retry:** Hub *Backorders → Sync* until SO exists  
- [ ] Line / SKU errors visible in Hub `last_error` / flow logs  

**References:** [01-order-creation-payment.md](./flows/01-order-creation-payment.md) · [D365_FLOWS_AND_STEPS.md](./D365_FLOWS_AND_STEPS.md)

---

## 2. Order fulfilment → “upstream” (toward Shopify / customer)

Confirm **which system** created the ship event, then match **D365** and **warehouse**.

### 2.1 GPS (cron / poll): 3PL ships first

| Check | D365 | Warehouse |
|-------|------|-----------|
| GPS status → shipped | New **packing slip / fulfilment** posting on the **same sales order** (`fulfilment` service → see [D365 Flow 3](./D365_FLOWS_AND_STEPS.md)) | **GPS US** batch → **U001** (typical); **GPS UK** batch → **H007** (typical) |
| Shopify | Fulfillment + tracking | Matches GPS carrier data |

- [ ] **D365:** `SalesOrderLines` shipped quantities align with what left the GPS site  
- [ ] Avoid **double** packing slip if Shopify also fired `orders/fulfilled` for the same ship (engineering check; otherwise watch duplicate postings in FO)  

**Reference:** [03-gps-fulfillment.md](./flows/03-gps-fulfillment.md)

### 2.2 Shopify-first fulfilment (Stord, manual, etc.)

| Check | D365 | Warehouse |
|-------|------|-----------|
| `orders/fulfilled` in Shopify | **Packing slip** on SO ([Flow 2](./D365_FLOWS_AND_STEPS.md)) | **Stord / HK** style routes — line **warehouse/site** per IM8 config |

- [ ] **D365:** `SalesOrderHeadersV3` + lines show posted fulfilment for fulfilled SKUs  
- [ ] **Hub** fulfillment state matches Shopify  

**Reference:** [07-shopify-direct-fulfillment.md](./flows/07-shopify-direct-fulfillment.md)

### 2.3 D365-initiated (ERP posts first)

| Check | D365 | Warehouse |
|-------|------|-----------|
| Shipment posted in FO | Sales order already holds inventory issue; webhook notifies Battle Bus | Same company as the SO (**`dataAreaId`** in payload, e.g. `U001`) |
| Shopify | Fulfillment appears after writeback | N/A in D365 |

- [ ] **Shopify** fulfillment exists with correct qty  
- [ ] Feature flag **`ENABLE_SHOPIFY_FULFILLMENT_WRITEBACK`** for environment respected  

**Reference:** [10-dynamics-initiated-shopify-fulfillment.md](./flows/10-dynamics-initiated-shopify-fulfillment.md)

### 2.4 Stord-specific

- [ ] Correct **legal entity** and **line warehouse** for EU vs ATL (refund SKU differs — [05-refunds](./flows/05-refunds.md))  
- [ ] Carrier / tracking in **Shopify** matches what finance expects for that Stord region  

---

## 3. Refunds

| Check | D365 entities | Warehouse / SKU |
|-------|----------------|-----------------|
| Refund amount & tax | **`SalesOrderLines`** on the **same SO** (negative qty + **refund item** from config) | Refund SKU: e.g. **IM8-SER-000003** (IM8 GPS/UK/HK, STORD EU) or **IM8-SER-000005** (STORD ATL); CircleDNA **PRE-SER-000023** ([05-refunds](./flows/05-refunds.md)) |
| Return logistics | **Return fulfilment** / site from warehouse config | Return **site / warehouse / location** must match configured return warehouse |

- [ ] **D365:** No **duplicate** negative line for the same Shopify **refund id** (verify line count / amounts)  
- [ ] **Partial vs full:** line quantities and order financial status in **Shopify** and **D365**  
- [ ] Refund **before** SO exists: Hub / queues show expected wait or retry (no orphan credit in D365)  

**Reference:** [05-refunds.md](./flows/05-refunds.md)

---

## 4. Cancellations

| Check | D365 | Warehouse / 3PL |
|-------|------|-------------------|
| Cancel before ship | May have **no** return SO; GPS cancel may succeed | **GPS US/UK:** cancel outbound in OMS; **Stord:** follow tenant rules |
| Cancel after ship / GPS refuses | **Return order** header + **return lines** on original SO path ([D365 Flow 4](./D365_FLOWS_AND_STEPS.md)) | Return warehouse per configuration |
| Legacy exclusion | Internal / Hub may show dummy fulfillment id — **GPS polling** must ignore | N/A in D365 UI ([06-cancellations](./flows/06-cancellations.md)) |

Production orchestration (GPS cancel + Shopify uncancel): [08-cancel-gps-and-uncancel.md](./flows/08-cancel-gps-and-uncancel.md).

- [ ] **Shopify** shows cancelled (or restored after uncancel) as designed  
- [ ] **D365:** If return flow ran, **`SalesOrderHeadersV3` / `SalesOrderLines`** for return order present  
- [ ] **GPS:** outbound cancelled or terminal failure documented  

---

## 5. Quick matrix (D365 + warehouse)

| Scenario | D365 focus | Company / 3PL |
|----------|------------|----------------|
| Create (GPS US) | `SalesOrderHeadersV3`, `SalesOrderLines` | **U001** + GPS US id |
| Create (GPS UK) | Same entities | **H007** + GPS UK id |
| Create (Stord) | Same entities; site on lines | Stord/HK site; no GPS |
| Fulfil (GPS) | Packing slip / fulfilment on SO | U001 vs H007 by batch |
| Fulfil (Shopify / Stord) | Packing slip from `orders/fulfilled` path | Stord/HK warehouse on lines |
| Fulfil (D365-led) | Shipment already in FO → webhook out | `dataAreaId` on integration payload |
| Refund | SO lines + refund SKU + return fulfilment | Refund SKU by region (EU vs ATL) |
| Cancel | Original SO + optional **return** header/lines | GPS cancel vs return warehouse |

---

## 6. Reference: Inngest (optional)

Only for engineers with dashboard access:

| Topic | Where |
|-------|--------|
| Run failed after Shopify webhook | Inngest → function (e.g. `process-shopify-order`, `process-shopify-fulfillment`, `process-shopify-refund`) → step error |
| Cron GPS | Scheduled `cron-gps-sync` runs |

Does **not** replace checks in **D365**, **Shopify**, or **Hub**.

---

## 7. Related index

| Doc | Topic |
|-----|--------|
| [flows/README.md](./flows/README.md) | All numbered flows + simulator commands |
| [D365_FLOWS_AND_STEPS.md](./D365_FLOWS_AND_STEPS.md) | Step-by-step D365 API usage |
| [ARCHITECTURE_EXPLAINED.md](./ARCHITECTURE_EXPLAINED.md) | High-level system diagram |

After a major change, run the integration commands in [flows/README.md § Quick Start](./flows/README.md#-quick-start) where applicable (`flow:order` with `--fulfill`, `--cancel`, `--refund`).
