# D365 Fulfillment Investigation: "Already Invoiced" Mismatch

Date: 2026-04-05  
Owner: Battle Bus Inngest investigation

## Finding (Final)

For sales order `H007-SO-101902`, the THK fulfillment API returns line-level `partially invoiced / already invoiced` errors for product lines that appear as `Open order` in Finance and Operations UI.

This confirms an upstream mismatch between:

- THK API fulfillment state evaluation, and
- FO UI line status display for the same order lines.

## Order Investigated

- Shopify order name: `IM8-19335`
- Shopify order id: `6999461101800`
- D365 sales order: `H007-SO-101902`
- Data area: `H007`

## Evidence from FO UI

In FO (All sales orders), order `H007-SO-101902` shows:

- Header status: `Open order`
- Line `IM8-FG-000031`: `Open order`
- Line `IM8-FG-000011`: `Open order`
- Line `IM8-SER-000004`: `Open order`

## Direct API Reproduction (Local)

A direct local call was made using `.env.local` credentials to:

- `POST /api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment`
- Base URL: `https://p-uat.sandbox.operations.dynamics.com`

Request body used:

```json
{
  "_dataContract": {
    "DataAreaId": "H007",
    "Type": "shipment",
    "D365FOSalesOrder": "H007-SO-101902",
    "ConfirmedShippedDate": "2026-04-05",
    "Lines": [
      {
        "ItemNumber": "IM8-FG-000031",
        "Quantity": 1,
        "Site": "Prenetics",
        "TrackingNumber": "LOCAL-TEST-H007-101902",
        "Lotid": "H007-339177"
      },
      {
        "ItemNumber": "IM8-FG-000011",
        "Quantity": 1,
        "Site": "Prenetics",
        "TrackingNumber": "LOCAL-TEST-H007-101902",
        "Lotid": "H007-339178"
      }
    ]
  }
}
```

THK responses:

1) First call:

```json
{
  "status": 0,
  "Message": " Sales order H007-SO-101902 partially invoiced. The following SKUs/item number(IM8-FG-000031) in SO line 1.00 are already invoiced",
  "Result": ""
}
```

2) Retry with remaining product line:

```json
{
  "status": 0,
  "Message": " Sales order H007-SO-101902 partially invoiced. The following SKUs/item number(IM8-FG-000011) in SO line 2.00 are already invoiced",
  "Result": ""
}
```

## Interpretation

- The lot IDs were present and valid in the request.
- THK still classified both product lines as already invoiced.
- Therefore the issue is not missing Lotid for this reproduction.
- The issue is THK fulfillment service behavior/state disagreement versus FO UI line status.

## Scope Clarification

This document captures the mismatch finding only.  
It does not redefine business behavior; it records observed API/UI inconsistency for escalation to Dynamics/THK owners.

