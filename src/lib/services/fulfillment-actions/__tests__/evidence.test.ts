import { describe, expect, it } from "vitest";
import { matchShipmentEvidence } from "../evidence";
import type { FulfillmentRecoveryContext } from "../recovery-context";
const context: FulfillmentRecoveryContext = {
  version: 1,
  kind: "d365_shipment",
  company: "H007",
  salesOrderNumber: "SO1",
  postingDate: "2026-10-28",
  lines: [{ lotId: "lot", itemNumber: "sku", quantity: 2 }],
};
const header = {
  dataAreaId: "h007",
  SalesOrderNumber: "SO1",
  THK_ShopifyReference: "O1",
  CurrencyCode: "USD",
  SalesOrderProcessingStatus: "Invoiced",
};
const slip = {
  dataAreaId: "h007",
  SalesId: "SO1",
  PackingSlipId: "P1",
  InventTransId: "lot",
  ItemId: "sku",
  Qty: 2,
  DeliveryDate: "2026-10-28T00:00:00Z",
};
describe("automatic fulfillment recovery evidence", () => {
  it("accepts exact document and final invoice evidence", () => {
    expect(matchShipmentEvidence(context, [header], [slip])?.documentId).toBe("P1");
  });
  it("rejects missing invoices, duplicate matching documents, wrong lines and companies", () => {
    expect(
      matchShipmentEvidence(
        context,
        [{ ...header, SalesOrderProcessingStatus: "PartiallyInvoiced" }],
        [slip]
      )
    ).toBeNull();
    for (const slips of [
      [slip, { ...slip, PackingSlipId: "P2" }],
      [{ ...slip, Qty: 1 }],
      [{ ...slip, dataAreaId: "u001" }],
      [{ ...slip, InventTransId: "other" }],
      [{ ...slip, DeliveryDate: "2026-10-27" }],
    ])
      expect(matchShipmentEvidence(context, [header], slips)).toBeNull();
  });
});
