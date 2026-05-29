/**
 * Integration: refund lane routing + THK fulfilment body for U001 and H007.
 *
 * Mirrors spock-store processNonLoopRefund expectations without calling D365.
 */

import { describe, expect, it } from "vitest";
import { buildThkFulfilmentRequestBody } from "@/lib/helpers/d365-thk-fulfilment";
import {
  getServiceSkuOverridesByDataArea,
  getRefundSku,
  getReturnConfig,
  getWarehouseConfig,
  resolveRefundFulfillmentWarehouse,
} from "@/lib/helpers/warehouse";
import { analyzeRefundAmount } from "@/lib/utils/shopify-refund-amount";
import { resolveRefundAmountUsd } from "@/lib/helpers/exchange";
import { loadFixture } from "../fixtures";

describe("D365 refund lanes — U001", () => {
  const u001RefundSku = getServiceSkuOverridesByDataArea()["U001"].refund;

  it("STORD ATL + U001 header → UAT/env refund SKU and USOPS-WH05-Q return site", () => {
    const fulfillmentWarehouse = resolveRefundFulfillmentWarehouse("US", "STORD ATL Location");
    const profile = getWarehouseConfig(fulfillmentWarehouse);

    expect(fulfillmentWarehouse).toBe("STORD ATL Location");
    expect(getRefundSku(fulfillmentWarehouse, "U001")).toBe(u001RefundSku);
    expect(profile.return.shippingWarehouseId).toBe("USOPS-WH05-Q");
    expect(profile.return.shippingWarehouseLocationId).toBe("Return");
  });

  it("builds spock-store-aligned return fulfilment body for U001", () => {
    const returnCfg = getReturnConfig("STORD ATL Location");
    const refundSku = getRefundSku("STORD ATL Location", "U001");
    const refundAmountUsd = 190.46;

    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "U001",
      type: "return",
      salesOrderNumber: "U001-SO-597892",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: refundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "REFUND-LOT-1",
        },
      ],
    });

    expect(body._dataContract).toMatchObject({
      DataAreaId: "U001",
      Type: "return",
      D365FOSalesOrder: "U001-SO-597892",
    });
    expect(body._dataContract.Lines[0]).toMatchObject({
      ItemNumber: u001RefundSku,
      Quantity: -1,
      Warehouse: "",
      Location: "",
    });
    expect(refundAmountUsd).toBeGreaterThan(0);
  });

  it("converts presentment refund to USD for D365 line price", () => {
    const order = loadFixture("gpsUsOrder");
    const refund = {
      transactions: [
        {
          kind: "refund",
          status: "success",
          amount: "129.99",
          currency: "USD",
        },
      ],
    };

    const breakdown = analyzeRefundAmount(refund as any);
    const resolved = resolveRefundAmountUsd({
      refundAmount: breakdown.amount,
      shopifyOrder: order,
      refund: refund as any,
    });

    expect(breakdown.amount).toBe(129.99);
    expect(resolved.refundAmountUsd).toBe(129.99);
    expect(resolved.conversionApplied).toBe(false);
  });
});

describe("D365 refund lanes — H007", () => {
  const h007RefundSku = getServiceSkuOverridesByDataArea()["H007"].refund;

  it("GPS UK + H007 header → profile refund SKU and OPS-WH02-Q return site", () => {
    const fulfillmentWarehouse = resolveRefundFulfillmentWarehouse("GB", null);
    const profile = getWarehouseConfig(fulfillmentWarehouse);

    expect(fulfillmentWarehouse).toBe("GPS UK Warehouse");
    expect(profile.dataAreaId).toBe("H007");
    expect(getRefundSku(fulfillmentWarehouse, "H007")).toBe(h007RefundSku);
    expect(profile.return.shippingWarehouseId).toBe("OPS-WH02-Q");
  });

  it("HK warehouse sample lane → OPS-WH01 return site", () => {
    const profile = getWarehouseConfig("HK Warehouse");
    expect(profile.dataAreaId).toBe("H007");
    expect(profile.return.shippingWarehouseId).toBe("OPS-WH01");
    expect(profile.return.shippingWarehouseLocationId).toBe("Return");
  });

  it("builds return fulfilment body with explicit H007 quarantine warehouse", () => {
    const returnCfg = getReturnConfig("GPS UK Warehouse");
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "return",
      salesOrderNumber: "H007-SO-124123",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: h007RefundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "H007-REFUND-LOT-1",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).toMatchObject({
      ItemNumber: h007RefundSku,
      Quantity: -1,
      Warehouse: "OPS-WH02-Q",
      Location: "Return",
    });
  });

  it("does not send warehouse on H007 shipment fulfilment body", () => {
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "shipment",
      salesOrderNumber: "H007-SO-124123",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: "IM8-FG-000242",
          quantity: 1,
          shippingSiteId: "Prenetics",
          shippingWarehouseId: "OPS-WH01",
          shippingWarehouseLocationId: "Primary",
          trackingNumber: "LOCAL-H007-001",
          lotId: "H007-392014",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).not.toHaveProperty("Warehouse");
    expect(body._dataContract.Lines[0]).not.toHaveProperty("Location");
  });
});
