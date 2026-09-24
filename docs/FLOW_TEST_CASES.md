# Battle Bus Flow Test Cases

This is the single source of truth for testing every Battle Bus flow. Each flow section contains: **goal**, **preconditions**, **constraints**, **test steps**, **expected behavior**, **failure expectations**, and a **results table** to fill in during execution.

---

## How to use this document

1. Before a release or after major changes, go through each flow section.
2. For each test case, execute the steps described.
3. Fill in the **Results** table: actual result, status (Pass/Fail/Blocked), evidence (Inngest run ID, order ID, screenshot URL, log snippet), and tester name.
4. Any failure must have a linked issue or explanation in the notes column.

### Status definitions

| Status  | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| Pass    | Expected behavior observed. Evidence captured.                       |
| Fail    | Expected behavior NOT met. Defect logged.                            |
| Blocked | Cannot execute due to environment, credentials, or dependency issue. |
| Skipped | Intentionally skipped with documented reason.                        |

---

## Flow 1: Order Creation & D365/GPS Sync

### Goal

Verify that a Shopify order (`orders/paid` or `orders/created`) is correctly processed end-to-end: validated, D365 sales order header + lines created, GPS outbound order created (for GPS warehouses only), and Supabase order record updated with all sync statuses.

### Preconditions

- Inngest dev server running (`npm run dev:inngest`)
- Battle Bus running (`npm run dev`)
- Valid Shopify, D365, GPS credentials configured
- Supabase orders table accessible
- At least one GPS warehouse location and one non-GPS location configured in `locations` table

### Constraints

- D365 API may be rate-limited; allow retries.
- GPS API requires valid warehouse credentials (US key for US, UK key for UK).
- Tag wait delay may add 5+ minutes unless `TAG_WAIT_ENABLED=false`.
- Fiscal period must be open in D365 for prepayment (if tested end-to-end with fulfillment).

### Test cases

#### TC-ORD-001: Standard GPS order (US)

| Field                   | Value                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**         | US customer order routed to GPS US warehouse                                                                                                                                                |
| **Trigger**             | `shopify/order.paid` event with US shipping address                                                                                                                                         |
| **Steps**               | 1. Send order event (or create test order via Hub mass-test or Shopify). 2. Monitor `process-shopify-order` in Inngest dashboard. 3. Verify Supabase order record.                          |
| **Expected**            | D365 SO header created. D365 SO lines created for each shippable line. GPS outbound order created. Supabase: `d365_sync_status=synced`, `gps_sync_status=synced`, `gps_order_no` populated. |
| **Failure expectation** | If D365 fails: order retries per config. If GPS fails with inventory issue: routed to backorder queue. If GPS credentials wrong: non-retryable error with Chinese error message.            |

#### TC-ORD-002: Standard non-GPS order (Stord/Charlotte)

| Field           | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| **Description** | Order routed to non-GPS warehouse (e.g. Charlotte/Stord)                               |
| **Trigger**     | `shopify/order.paid` event with location mapped to non-GPS warehouse                   |
| **Steps**       | 1. Send order event. 2. Monitor run. 3. Verify Supabase.                               |
| **Expected**    | D365 SO created. GPS steps skipped (`gps_sync_status=skipped`). No GPS outbound order. |

#### TC-ORD-003: UK GPS order

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Description** | UK customer order routed to GPS UK warehouse (H007)                                      |
| **Trigger**     | `shopify/order.paid` with GB shipping address                                            |
| **Steps**       | 1. Send order event. 2. Monitor run. 3. Verify GPS UK order created with UK credentials. |
| **Expected**    | `dataAreaId=H007`. GPS UK order created. `gps_order_no` populated.                       |

#### TC-ORD-004: Multi-line item order

| Field           | Value                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| **Description** | Order with 3+ line items including different SKUs                                               |
| **Trigger**     | `shopify/order.paid` with multiple line items                                                   |
| **Steps**       | 1. Send order event. 2. Verify all D365 lines created. 3. Verify GPS payload includes all SKUs. |
| **Expected**    | One D365 line per shippable SKU + shipping/tax service lines. GPS `productList` matches.        |

#### TC-ORD-005: Duplicate/rerun order

| Field           | Value                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| **Description** | Rerun of an already-processed order                                                |
| **Trigger**     | Rerun from Hub or duplicate event                                                  |
| **Steps**       | 1. Process order once. 2. Rerun same order. 3. Verify idempotency.                 |
| **Expected**    | Second run detects existing D365 order (`already_exists`). No duplicate GPS order. |

### Results

| Case       | Actual result                                                                                     | Status  | Evidence                                                                                                          | Tester | Date       | Notes                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| TC-ORD-001 | D365 SO `U001-SO-496889`; GPS outbound `OBS1352603310RX`; Hub order **completed**, **All Synced** | Pass    | Shopify **IM8-19150**; Inngest run `01KN14VR4C3W…`; warehouse **GPS Warehouse**; line SKU `IM8-FG-000035`         |        | 2026-03-31 | Paid Mar 31 ~1:12 PM; fulfillment still unfulfilled at Shopify (expected pre-ship).                                                       |
| TC-ORD-002 | D365 SO `U001-SO-496899`; no GPS order; Hub **Reached Stord** / Stord path                        | Pass    | Shopify **IM8-19183**; Inngest run `01KN1HR9FY1F…`; warehouse **STORD ATL Location**; SKU `IM8-FG-000224`         |        | 2026-03-31 | Matches Stord/non-GPS. **Also observed:** IM8-19153 **HK Warehouse** — D365 `H007-SO-101831`, GPS **N/A** (additional non-GPS datapoint). |
| TC-ORD-003 | D365 SO `H007-SO-101830`; GPS UK `OBS2262603310RV`; Hub **All Synced**                            | Pass    | Shopify **IM8-19152**; Inngest run `01KN14VRHQXW…`; warehouse **GPS UK Warehouse** (`H007`); line `IM8-FG-000035` |        | 2026-03-31 | Paid Mar 31 ~1:12 PM.                                                                                                                     |
| TC-ORD-004 | —                                                                                                 | Skipped | —                                                                                                                 |        | 2026-03-31 | Not executed in this batch (only single-line test orders).                                                                                |
| TC-ORD-005 | —                                                                                                 | Skipped | —                                                                                                                 |        | 2026-03-31 | Hub **Rerun** / duplicate-event idempotency not executed in this batch.                                                                   |

---

## Flow 2: Null SKU Recovery

### Goal

Verify that when a shippable Shopify line item has a null or empty SKU, the system attempts to recover the latest SKU from Shopify via GraphQL variant lookup before failing the order.

### Preconditions

- Shopify store has at least one product variant with a recently updated SKU
- A test order exists (or can be created) with a line item whose SKU is empty but `variant_id` is valid

### Constraints

- Shopify Admin GraphQL API must be accessible.
- If the variant itself has no SKU in Shopify, recovery is impossible and the order must fail.
- Non-shippable lines (e.g. insurance add-ons with `requires_shipping=false`) are always skipped regardless of SKU.

### Test cases

#### TC-SKU-001: Successful SKU recovery

| Field           | Value                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Shippable line has null SKU, but variant in Shopify has a valid SKU                                                                                                     |
| **Trigger**     | `shopify/order.paid` with a line item where `sku=""` and `variant_id=<valid>`                                                                                           |
| **Steps**       | 1. Update variant SKU in Shopify Admin. 2. Create/send order event with empty SKU. 3. Monitor `resolve-missing-line-skus` step. 4. Verify D365 lines use recovered SKU. |
| **Expected**    | `resolve-line-skus` completes with `resolved=1`. D365 lines created with correct SKU. Order completes successfully.                                                     |

#### TC-SKU-002: Unrecoverable null SKU (terminal failure)

| Field           | Value                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Shippable line has null SKU and variant in Shopify also has no SKU                                                                |
| **Trigger**     | `shopify/order.paid` with empty SKU and variant that has no SKU in Shopify                                                        |
| **Steps**       | 1. Ensure variant has no SKU in Shopify. 2. Send order event. 3. Monitor step.                                                    |
| **Expected**    | `resolve-line-skus` fails. Error message: `Missing SKU/ItemNumber after Shopify variant refresh`. Order does NOT proceed to D365. |

#### TC-SKU-003: Non-shippable line with null SKU (should be ignored)

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Description** | Non-shippable line item (insurance/fee) has null SKU                                     |
| **Trigger**     | Order with a line where `requires_shipping=false` and `sku=""`                           |
| **Steps**       | 1. Send order event. 2. Verify `resolve-missing-line-skus` reports `attempted=0`.        |
| **Expected**    | Non-shippable line ignored. No GraphQL call made for that line. Order proceeds normally. |

#### TC-SKU-004: Mixed lines (some null, some valid)

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Order with 3 lines: 1 valid SKU, 1 recoverable null SKU, 1 non-shippable null SKU                                             |
| **Trigger**     | Mixed order event                                                                                                             |
| **Steps**       | 1. Send event. 2. Verify only the shippable null-SKU line triggers GraphQL. 3. Verify all 2 shippable lines end up with SKUs. |
| **Expected**    | `attempted=1`, `resolved=1`. D365 creates lines for both shippable items. Non-shippable line skipped in D365 transformer.     |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-SKU-001 |               |        |          |        |      |       |
| TC-SKU-002 |               |        |          |        |      |       |
| TC-SKU-003 |               |        |          |        |      |       |
| TC-SKU-004 |               |        |          |        |      |       |

---

## Flow 3: Backorder Queue & Retry

### Goal

Verify that orders failing due to inventory issues (out of stock, item not found) are correctly routed to the backorder queue, and that retry (single and filtered batch) works correctly with the guarded Retry All UX.

### Preconditions

- GPS sync enabled
- A SKU that will trigger an out-of-stock or item-not-found error in GPS or D365
- Hub Backorders page accessible

### Constraints

- Backorder retry may fail again if inventory is still unavailable.
- Retry All requires explicit date/status/error filters and user confirmation.

### Test cases

#### TC-BO-001: Order routed to backorder on OOS

| Field           | Value                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | GPS returns out-of-stock for a SKU                                                                                                                          |
| **Trigger**     | Order with a SKU that GPS rejects as OOS                                                                                                                    |
| **Steps**       | 1. Send order event. 2. GPS returns inventory error. 3. Verify backorder event emitted. 4. Check Hub Backorders page.                                       |
| **Expected**    | Supabase: `processing_status=waiting_stock`. `backorder/created` event emitted with `errorType`, `failedSkus`. Backorder visible in Hub with error details. |

#### TC-BO-002: Single backorder retry (success)

| Field           | Value                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Description** | Retry a single backorder after inventory is restocked                                               |
| **Steps**       | 1. Restock SKU. 2. Retry single order from Hub. 3. Monitor reprocessing.                            |
| **Expected**    | Order reprocessed. D365 + GPS created. Status changes to `completed`. Backorder removed from queue. |

#### TC-BO-003: Retry All requires filters

| Field           | Value                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Attempt Retry All without filters                                                                                                  |
| **Steps**       | 1. Go to Backorders page. 2. Click Retry All without applying any filter.                                                          |
| **Expected**    | UI prevents retry. Must apply at least one filter (date range, error type, or status). Confirmation dialog shown before execution. |

#### TC-BO-004: Filtered Retry All

| Field           | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Description** | Retry All with date and error type filters applied                                                        |
| **Steps**       | 1. Apply date filter and error type filter. 2. Click Retry All. 3. Confirm in dialog. 4. Monitor retries. |
| **Expected**    | Only matching backorders retried. Non-matching backorders untouched.                                      |

### Results

| Case      | Actual result | Status | Evidence | Tester | Date | Notes |
| --------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-BO-001 |               |        |          |        |      |       |
| TC-BO-002 |               |        |          |        |      |       |
| TC-BO-003 |               |        |          |        |      |       |
| TC-BO-004 |               |        |          |        |      |       |

---

## Flow 4: Order Cancellation

### Goal

Verify that cancellation only relays to GPS for GPS orders and performs no D365 action for any order type. Verify the Shopify uncancel safeguard when GPS cancel fails.

### Preconditions

- A processed GPS order with GPS metafield data
- A processed non-GPS order
- GPS sync enabled

### Constraints

- GPS cancel may fail if order is already shipped or in-flight.
- No D365 action is expected on cancel (no deletion, no modification).

### Test cases

#### TC-CAN-001: Cancel GPS order (GPS cancel succeeds)

| Field           | Value                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | Cancel a GPS warehouse order where GPS OMS accepts the cancel                                                                                    |
| **Trigger**     | `shopify/order.cancelled` for GPS order                                                                                                          |
| **Steps**       | 1. Cancel order in Shopify (or via Hub action). 2. Monitor `process-order-cancellation`. 3. Verify GPS API called. 4. Verify NO D365 calls made. |
| **Expected**    | GPS cancel API called and succeeds. No D365 lookup or modification. CS platform notified. Status: `success`.                                     |

#### TC-CAN-002: Cancel GPS order (GPS cancel fails — already shipped)

| Field           | Value                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Cancel a GPS order that has already been shipped                                                                           |
| **Trigger**     | `shopify/order.cancelled` for shipped GPS order                                                                            |
| **Steps**       | 1. Cancel order. 2. GPS cancel returns failure. 3. Verify Shopify uncancel.                                                |
| **Expected**    | GPS cancel fails. Shopify `uncancelOrder` called to restore order. Slack warning sent. Status: `reverted`. No D365 action. |

#### TC-CAN-003: Cancel non-GPS order

| Field           | Value                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| **Description** | Cancel an order routed to a non-GPS warehouse                                     |
| **Trigger**     | `shopify/order.cancelled` for non-GPS order                                       |
| **Steps**       | 1. Cancel order. 2. Monitor run.                                                  |
| **Expected**    | No GPS action (skipped). No D365 action. CS platform notified. Status: `success`. |

#### TC-CAN-004: Deferred cancellation (GPS order not yet created)

| Field           | Value                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| **Description** | Cancel arrives before GPS order creation completes                                           |
| **Trigger**     | `shopify/order.cancelled` before `process-shopify-order` finishes                            |
| **Steps**       | 1. Send cancel event for order still being processed. 2. Verify deferral. 3. Wait for drain. |
| **Expected**    | Cancel stored as pending action. `drain-pending-actions` replays it once GPS order exists.   |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-CAN-001 |               |        |          |        |      |       |
| TC-CAN-002 |               |        |          |        |      |       |
| TC-CAN-003 |               |        |          |        |      |       |
| TC-CAN-004 |               |        |          |        |      |       |

---

## Flow 5: Refund (D365 Credit Note Path)

### Goal

Verify that refunds create a negative sales order line in D365, post a return fulfilment, and post a return invoice to generate a credit note. Verify currency conversion and deferred refund handling.

### Preconditions

- A processed order with a D365 sales order number
- D365 sync enabled
- Refund SKU configured for the warehouse's data area

### Constraints

- Refund amount must be > 0.
- Currency conversion uses Shopify transaction exchange rate or static fallback.
- Return invoice step is non-blocking (Slack alert on failure, function still succeeds).
- D365 fiscal period must be open for the invoice date.

### Test cases

#### TC-REF-001: Full refund with credit note

| Field           | Value                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Full refund of a completed order                                                                                                                                                                                                         |
| **Trigger**     | `shopify/refund.created` with full refund amount                                                                                                                                                                                         |
| **Steps**       | 1. Create refund in Shopify or via Hub. 2. Monitor `process-shopify-refund`. 3. Verify all D365 steps.                                                                                                                                   |
| **Expected**    | Step sequence: get-shopify-order → get-d365-order → determine-warehouse → calculate-refund → create-refund-line (qty -1) → fulfill-refund-line (type: return) → post-return-invoice. Credit note number in result. CS platform notified. |

#### TC-REF-002: Partial refund

| Field           | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Description** | Partial refund (e.g. $50 of $200 order)                                                    |
| **Trigger**     | `shopify/refund.created` with partial amount                                               |
| **Steps**       | 1. Create partial refund. 2. Monitor run. 3. Verify D365 line price matches refund amount. |
| **Expected**    | D365 refund line `price = refundAmountUsd`. Return fulfilment and invoice posted.          |

#### TC-REF-003: Non-USD currency refund

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Description** | Refund in GBP or HKD                                                                                        |
| **Trigger**     | Refund for order with non-USD currency                                                                      |
| **Steps**       | 1. Refund non-USD order. 2. Verify USD conversion in logs.                                                  |
| **Expected**    | Refund amount converted to USD using exchange rate. D365 line uses USD amount. Conversion logged for audit. |

#### TC-REF-004: Deferred refund (D365 order not yet created)

| Field           | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Description** | Refund arrives before D365 order is created                                                                             |
| **Trigger**     | `shopify/refund.created` before order processing completes                                                              |
| **Steps**       | 1. Send refund event for in-progress order. 2. Verify pending action stored. 3. Wait for drain.                         |
| **Expected**    | Refund stored as pending action. Drained after order creation completes. On replay: D365 refund line + invoice created. |

#### TC-REF-005: Return invoice failure (non-blocking)

| Field           | Value                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | D365 `postReturnOrderInvoice` fails (e.g. closed fiscal period)                                                                                                |
| **Trigger**     | Refund where D365 fiscal period is closed                                                                                                                      |
| **Steps**       | 1. Trigger refund. 2. post-return-invoice step fails.                                                                                                          |
| **Expected**    | Refund line and return fulfilment succeed. Invoice step fails with Slack warning. Function returns success (non-blocking). `invoiceResult: "error"` in output. |

### Results

| Case       | Actual result                                                                                                                                                                                                                                      | Status  | Evidence                                                                                                                            | Tester | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-REF-001 | Not verified in this run (credit note / negative line / return fulfilment not confirmed in D365 UI)                                                                                                                                                | Blocked | Shopify **IM8-19176**; Hub shows D365 `U001-SO-496895`, financial **refunded**                                                      |        | 2026-03-31 | Refund function may have **deferred** (see TC-REF-004). After `drain-pending-actions` or replay, re-check D365 for return line + `post-return-invoice` credit note.                                                                                                                                                                                                                                                                    |
| TC-REF-002 |                                                                                                                                                                                                                                                    |         |                                                                                                                                     |        |            |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TC-REF-003 |                                                                                                                                                                                                                                                    |         |                                                                                                                                     |        |            |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TC-REF-004 | `process-shopify-refund` completed with **`store-pending-refund`**: `get-shopify-order` → `get-d365-order` → deferred because **D365 SO was not returned** at refund time (`d365Order` null). Run marked **deferred**, not full D365 refund steps. | Pass    | Shopify **IM8-19176** (Daniel Davis, Charlotte); Inngest **01KN1TAKDCWZ67KZEH0N4S619X**; Hub order-processing run **01KN1HR2HW73…** |        | 2026-03-31 | **Why no immediate D365 refund:** `process-refund.ts` only calls `create-d365-refund-line` when `getSalesOrderByShopifyId(shopifyOrder.name)` succeeds. If refund webhook runs **before** that lookup can see the SO (race) or lookup mismatch, refund is **queued** on `orders.pending_actions`. **Fix ops:** ensure order sync completed; run **Flow 7** drain or wait for cron; optional manual replay of `shopify/refund.created`. |
| TC-REF-005 |                                                                                                                                                                                                                                                    |         |                                                                                                                                     |        |            |                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## Flow 6: Fulfillment (Stord, GPS Cron, Manual)

### Goal

Verify that fulfillments from all sources (Stord webhook, GPS cron sync, Hub manual action) correctly trigger D365 packing slip + prepayment. Verify GPS webhook echo is skipped. Verify manual GPS fulfillment path.

### Preconditions

- A processed order with D365 sales order
- For GPS tests: GPS order in shipped status (status 3)
- For manual tests: Hub fulfillment action accessible

### Constraints

- GPS API has no "fulfill" endpoint; fulfillment is warehouse-driven.
- Manual GPS fulfillment from Hub requires GPS order status = 3 (shipped).
- GPS webhook echo (no `fromGpsSync`/`fromManualFulfillment` flag) must be skipped.
- D365 prepayment requires open fiscal period.

### Test cases

#### TC-FUL-001: Stord fulfillment (webhook path)

| Field           | Value                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| **Description** | Stord creates fulfillment in Shopify, webhook fires                                          |
| **Trigger**     | `shopify/order.fulfilled` from Stord (no GPS flags)                                          |
| **Steps**       | 1. Stord fulfills order. 2. Webhook event arrives. 3. Monitor `process-shopify-fulfillment`. |
| **Expected**    | D365 packing slip created. D365 prepayment posted. PayPal tracking synced (if applicable).   |

#### TC-FUL-002: GPS cron fulfillment

| Field           | Value                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | GPS cron detects order shipped (status 3)                                                                                                            |
| **Trigger**     | `cron-gps-sync` run                                                                                                                                  |
| **Steps**       | 1. GPS order reaches status 3. 2. Cron runs. 3. Shopify fulfillment created. 4. Canonical event emitted with `fromGpsSync: true`. 5. D365 sync runs. |
| **Expected**    | Shopify fulfillment created with GPS tracking. D365 packing slip + prepayment. Order marked fulfilled in Supabase.                                   |

#### TC-FUL-003: Manual fulfillment from Hub (non-GPS)

| Field           | Value                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | Manual fulfill action from Hub for non-GPS order                                                                               |
| **Trigger**     | `POST /api/actions/fulfillment` from Hub                                                                                       |
| **Steps**       | 1. Execute manual fulfill from Hub. 2. Verify canonical event emitted with `fromManualFulfillment: true`. 3. Verify D365 sync. |
| **Expected**    | Shopify fulfillment created. `shopify/order.fulfilled` emitted with manual flag. D365 packing slip + prepayment.               |

#### TC-FUL-004: Manual fulfillment from Hub (GPS order)

| Field           | Value                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Manual fulfill action from Hub for a GPS order                                                                                                           |
| **Trigger**     | `POST /api/actions/fulfillment` from Hub for GPS order                                                                                                   |
| **Steps**       | 1. GPS order must be status 3. 2. Execute manual fulfill. 3. Verify GPS tracking fetched. 4. Verify D365 sync runs (not skipped).                        |
| **Expected**    | GPS tracking fetched from API. Shopify fulfillment created with GPS tracking. D365 packing slip + prepayment runs (manual flag bypasses GPS skip logic). |

#### TC-FUL-005: GPS webhook echo skipped

| Field           | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Description** | GPS fulfillment echo from Shopify webhook (no flag)                                                       |
| **Trigger**     | `shopify/order.fulfilled` without `fromGpsSync` or `fromManualFulfillment`                                |
| **Steps**       | 1. After GPS cron creates fulfillment, Shopify fires echo webhook. 2. Monitor run.                        |
| **Expected**    | `process-shopify-fulfillment` returns `status: "skipped_gps"`. No D365 action (avoids double processing). |

#### TC-FUL-006: Deferred fulfillment (D365 order not yet created)

| Field           | Value                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Description** | Fulfillment arrives before D365 order creation                                                                 |
| **Trigger**     | `shopify/order.fulfilled` before order processing completes                                                    |
| **Steps**       | 1. Send fulfillment event for in-progress order. 2. Verify deferral.                                           |
| **Expected**    | Fulfillment stored as pending action. Drained after order creation. On replay: D365 packing slip + prepayment. |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-FUL-001 |               |        |          |        |      |       |
| TC-FUL-002 |               |        |          |        |      |       |
| TC-FUL-003 |               |        |          |        |      |       |
| TC-FUL-004 |               |        |          |        |      |       |
| TC-FUL-005 |               |        |          |        |      |       |
| TC-FUL-006 |               |        |          |        |      |       |

---

## Flow 7: Pending Actions Drain

### Goal

Verify that the cron-based drain sweep correctly replays all deferred lifecycle actions (cancel, refund, fulfill) in batch and clears them after processing.

### Preconditions

- Orders with pending actions in `orders.pending_actions` JSONB column
- `drain-pending-actions` cron running or manually triggered
- Downstream systems (D365/GPS) now ready

### Constraints

- Cron interval is configurable (`PENDING_ACTIONS_DRAIN_INTERVAL_MINUTES`).
- Concurrency limited to 1 (no overlapping sweeps).
- Actions replayed with `fromDrain: true` flag to prevent infinite deferral loops.

### Test cases

#### TC-PA-001: Drain replays deferred cancel

| Field           | Value                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Cancel was deferred because GPS order didn't exist yet; now it does                                                                         |
| **Steps**       | 1. Verify pending cancel action exists. 2. Trigger or wait for drain. 3. Verify cancel event re-emitted. 4. Verify pending actions cleared. |
| **Expected**    | `shopify/order.cancelled` re-emitted with `fromDrain: true`. Cancel processes successfully. `pending_actions` array emptied.                |

#### TC-PA-002: Drain replays multiple actions for different orders

| Field           | Value                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Description** | Multiple orders have pending actions                                                                             |
| **Steps**       | 1. Create 3+ orders with pending actions. 2. Trigger drain. 3. Verify batch emission.                            |
| **Expected**    | All events emitted in single `inngest.send` batch. All orders' pending actions cleared in single batch API call. |

#### TC-PA-003: Drain when downstream still not ready

| Field           | Value                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Drain replays but D365 order still doesn't exist                                                                          |
| **Steps**       | 1. Trigger drain for order where D365 is still missing.                                                                   |
| **Expected**    | Replayed function detects `fromDrain: true` and returns `status: "failed"` instead of deferring again (no infinite loop). |

### Results

| Case      | Actual result | Status | Evidence | Tester | Date | Notes |
| --------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-PA-001 |               |        |          |        |      |       |
| TC-PA-002 |               |        |          |        |      |       |
| TC-PA-003 |               |        |          |        |      |       |

---

## Flow 8: Config Cache Refresh

### Goal

Verify that the location config cache refreshes hourly via cron, can be manually pushed from Hub, and correctly persists to file + memory.

### Preconditions

- `refresh-location-config-cache` cron registered
- Hub Config page accessible
- `/api/config/cache` endpoint accessible

### Constraints

- Cache TTL is 1 hour.
- File snapshot persists across cold starts.
- If upstream (Supabase) is down, stale cache or file snapshot is used.

### Test cases

#### TC-CFG-001: Manual cache push from Hub

| Field           | Value                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Push Config Now button triggers cache refresh                                                                              |
| **Steps**       | 1. Click Push Config Now in Hub Config page. 2. Verify toast/response. 3. Call GET `/api/config/cache` to verify metadata. |
| **Expected**    | Cache refreshed. `reason: "manual_push"`. Timestamp updated. Location count matches.                                       |

#### TC-CFG-002: Hourly cron refresh

| Field           | Value                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| **Description** | Cron job refreshes cache every hour                                                                      |
| **Steps**       | 1. Check Inngest dashboard for `refresh-location-config-cache` runs. 2. Verify cache metadata after run. |
| **Expected**    | Cron executes. `reason: "hourly_cron"`. Cache updated with fresh data.                                   |

#### TC-CFG-003: Cache resilience when upstream is down

| Field           | Value                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Description** | Supabase unreachable during cache refresh                                                        |
| **Steps**       | 1. Simulate Supabase unavailability. 2. Trigger cache refresh.                                   |
| **Expected**    | Refresh fails gracefully. Stale in-memory cache or file snapshot used. No crash. Warning logged. |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-CFG-001 |               |        |          |        |      |       |
| TC-CFG-002 |               |        |          |        |      |       |
| TC-CFG-003 |               |        |          |        |      |       |

---

## Flow 9: Secret Manager Configuration & Controlled Deployment

### Goal

Verify that runtime secrets come from Google Secret Manager, deployments are
performed only by the gated GitHub Actions workflow, and missing configuration
fails closed.

### Preconditions

- GitHub `gcp-production` environment is configured.
- Workload Identity Federation is bound to the repository-specific deployer account.
- Required secrets exist in Google Secret Manager and the runtime account has least-privilege access.

### Constraints

- No long-lived Google service-account key is stored in GitHub.
- Production deployment remains disabled unless `ENABLE_GCP_DEPLOY=true`.
- Secret values must not be printed in build or deployment logs.

### Test cases

#### TC-ENV-001: Deploy with federated identity

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Deploy a passing `main` commit through GitHub Actions                                                                         |
| **Steps**       | 1. Enable the protected deployment environment. 2. Push an approved commit. 3. Inspect the Cloud Run revision and audit logs. |
| **Expected**    | GitHub exchanges OIDC for a short-lived credential, builds the image, verifies a no-traffic candidate, and promotes it.       |

#### TC-ENV-002: Deployment gate disabled

| Field           | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| **Description** | Push to `main` while `ENABLE_GCP_DEPLOY` is absent or false                           |
| **Steps**       | 1. Keep the gate disabled. 2. Push a commit. 3. Inspect the workflow and Cloud Run.   |
| **Expected**    | Quality gates run successfully; the deploy job is skipped and no revision is created. |

#### TC-ENV-003: Required secret missing

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Description** | Start a candidate revision without one required Secret Manager binding                                      |
| **Steps**       | 1. Remove the candidate's binding to a test-only required secret. 2. Run the deployment health check.       |
| **Expected**    | The candidate fails health verification, receives no production traffic, and the previous revision remains. |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-ENV-001 |               |        |          |        |      |       |
| TC-ENV-002 |               |        |          |        |      |       |
| TC-ENV-003 |               |        |          |        |      |       |

---

## Flow 10: Bulk Actions & Feature Flags

### Goal

Verify that the `VITE_ENABLE_ORDER_BULK_ACTIONS` feature flag correctly toggles bulk action UI in the Orders page.

### Preconditions

- Hub running
- Feature flag env var set

### Test cases

#### TC-BLK-001: Bulk actions disabled

| Field           | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| **Description** | Set `VITE_ENABLE_ORDER_BULK_ACTIONS=false`                              |
| **Steps**       | 1. Set flag to `false`. 2. Rebuild/reload Hub. 3. Go to Orders page.    |
| **Expected**    | No row selection checkboxes. No bulk action bar. No "Select rows" hint. |

#### TC-BLK-002: Bulk actions enabled (default)

| Field           | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| **Description** | Set `VITE_ENABLE_ORDER_BULK_ACTIONS=true` or leave unset                      |
| **Steps**       | 1. Set flag to `true`. 2. Rebuild/reload Hub. 3. Go to Orders page.           |
| **Expected**    | Row selection checkboxes visible. Bulk action bar appears when rows selected. |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-BLK-001 |               |        |          |        |      |       |
| TC-BLK-002 |               |        |          |        |      |       |

---

## Flow 11: Supabase RLS Security

### Goal

Verify that all public-schema tables have RLS enabled and that `anon`/`authenticated` roles cannot access service-only tables directly.

### Preconditions

- Supabase SQL Editor access
- Migration 014 applied

### Test cases

#### TC-RLS-001: Verify RLS enabled on all public tables

| Field           | Value                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| **Description** | Check `pg_tables` for RLS status                                                                                |
| **Steps**       | Run: `SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;` |
| **Expected**    | `rowsecurity = true` for ALL tables, especially `mission_runs`, `audit_log`, `audit_entities`.                  |

#### TC-RLS-002: Anon role cannot read audit_log

| Field           | Value                                              |
| --------------- | -------------------------------------------------- |
| **Description** | Attempt to read `audit_log` using anon key         |
| **Steps**       | 1. Use Supabase anon key to query `audit_log`.     |
| **Expected**    | Empty result or permission denied. No data leaked. |

#### TC-RLS-003: Service role can read/write all tables

| Field           | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| **Description** | Service role key should have full access                     |
| **Steps**       | 1. Use service role key to insert and read from `audit_log`. |
| **Expected**    | Insert succeeds. Read returns data.                          |

### Results

| Case       | Actual result | Status | Evidence | Tester | Date | Notes |
| ---------- | ------------- | ------ | -------- | ------ | ---- | ----- |
| TC-RLS-001 |               |        |          |        |      |       |
| TC-RLS-002 |               |        |          |        |      |       |
| TC-RLS-003 |               |        |          |        |      |       |

---

## Execution summary

Fill this after completing all flows:

| Flow                     | Total cases | Pass | Fail | Blocked | Skipped |
| ------------------------ | ----------- | ---- | ---- | ------- | ------- |
| 1. Order creation        | 5           | 3    | 0    | 0       | 2       |
| 2. Null SKU recovery     |             |      |      |         |         |
| 3. Backorder & retry     |             |      |      |         |         |
| 4. Cancellation          |             |      |      |         |         |
| 5. Refund                |             |      |      |         |         |
| 6. Fulfillment           |             |      |      |         |         |
| 7. Pending actions drain |             |      |      |         |         |
| 8. Config cache          |             |      |      |         |         |
| 9. Env sync & redeploy   |             |      |      |         |         |
| 10. Bulk actions flag    |             |      |      |         |         |
| 11. Supabase RLS         |             |      |      |         |         |
| **TOTAL**                |             |      |      |         |         |

**Tested by:**
**Date:**
**Environment:**
**Build/commit:**
**Overall verdict:** Pass / Fail / Conditional Pass
