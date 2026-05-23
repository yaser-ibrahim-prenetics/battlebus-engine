# D365 Deposit Fulfillment: Missing Standard Invoice After Shipment

Date: 2026-05-21  
Owner: Battle Bus Inngest

## Symptom

H007 deposit orders (`THK_DepositFulfillment=Yes`) show:

- Invoice journal: **Prepayment** only (from `PostPrepayment` at order create)
- Sales order lines: **Delivered** (packing slip posted at fulfillment)
- Header: **`PartiallyInvoiced`** (never reaches fully invoiced)
- Missing: second invoice journal row with **Customer invoice type = Standard**

Hub marks fulfillment **completed** because THK returns `status: 1`.

## Root cause (two layers)

### 1. Battle Bus treated THK `status: 1` as full success

For deposit orders, THK often returns:

```text
Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02
```

**Without** `Number of vouchers posted to the journal: 1`.

That pattern posts the **packing slip** (Delivered) but **not** the Standard invoice voucher.
Battle Bus logged `d365_fulfilment_posted` as completed anyway.

Compare working U001 / older H007 runs where the same warehouse warning **includes**:

```text
Number of vouchers posted to the journal: 1
```

### 2. Fulfilment request omitted warehouse dimensions for HK

`process-shopify-fulfillment` was posting lines with site `Prenetics` only (empty warehouse/location),
while order create uses `OPS-WH01` from `warehouse-config.json`. D365 header defaults to `OPS-WH02`,
creating a warehouse dimension mismatch that correlates with THK skipping the Standard voucher.

GPS individual flow already passed warehouse config; Shopify direct fulfillment did not.

### 3. THK "partially invoiced / already invoiced" idempotent path

After prepayment, THK may reject shipment with "already invoiced" (conflating prepayment with line invoice).
Battle Bus can synthesize `FULFILMENT_ALREADY_PROCESSED` while the header remains `PartiallyInvoiced`.

See also: `D365_FULFILLMENT_ALREADY_INVOICED_MISMATCH.md`.

## Fix in Battle Bus

1. **Pass warehouse config** from `getFulfilmentConfig()` in `process-shopify-fulfillment` (HK → `OPS-WH01/Primary`).
2. **After shipment on deposit orders**, verify:
   - THK message includes invoice voucher **or** passes clean success (defer to OData)
   - Header `SalesOrderProcessingStatus` is fully invoiced (not `PartiallyInvoiced`)
3. **Fail fulfillment** → backorder queue (`d365_fulfilment_incomplete`) when Standard invoice missing.

Functions: `assertDepositShipmentInvoicingComplete`, `verifyDepositShipmentInvoicingComplete`.

## D365 / THK escalation (still required)

If warehouse fix + replay still fails, escalate to THK owners:

- Deposit fulfilment shipment should always post **Standard** customer invoice
- THK must not return `status: 1` when only packing slip posted and finance leg skipped
- Align inventory transaction warehouse (`OPS-WH01` vs `OPS-WH02`) for H007 D2C orders

## spock-store PostPrepayment parity (2026-05-21)

Battle Bus now matches spock-store for prepayment:

| Aspect | spock-store | Battle Bus (fixed) |
|--------|-------------|-------------------|
| API body | `{ DataAreaId, SalesId }` only | Same |
| When called | Once at order create, after confirm + lines | Same (removed fulfillment-time call) |
| Gate | `calculateSalesOrderCost(lines) > 0` | Same |
| On THK failure | Throws (blocks order) | Same |
| GPS US customer | `U001-C000000006` | Same as spock US production snapshots |
| STORD US customer | `U001-C000000006` | Same |
| Header warehouse | Not set on header | Removed `DefaultShippingWarehouseId` from header |
| Fulfillment prepayment | Never | Removed `d365-post-prepayment` step |

## Recovery

1. Fix/deploy Battle Bus
2. Replay affected orders from Hub **Backorders → Fulfilment**
3. Confirm invoice journal shows **Prepayment + Standard**
4. Confirm header leaves `PartiallyInvoiced`
