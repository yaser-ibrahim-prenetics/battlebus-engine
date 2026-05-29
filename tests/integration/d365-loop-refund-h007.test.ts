/**
 * Loop return.closed → synthetic Shopify refund → H007 D365 return fulfilment body.
 * Mirrors spock-store processLoopRefundOnly → processNonLoopRefund.
 */

import { describe, expect, it } from "vitest";
import { buildThkFulfilmentRequestBody } from "@/lib/helpers/d365-thk-fulfilment";
import {
  buildSyntheticShopifyRefundFromLoopReturn,
  isLoopReturnClosedPayload,
  loopClosedReturnRefundIsPositive,
} from "@/lib/helpers/loop-return-refund";
import { analyzeRefundAmount } from "@/lib/utils/shopify-refund-amount";
import { resolveRefundAmountUsd } from "@/lib/helpers/exchange";
import {
  getServiceSkuOverridesByDataArea,
  getRefundSku,
  getReturnConfig,
} from "@/lib/helpers/warehouse";

describe("Loop refund — H007 D365 path", () => {
  const h007RefundSku = getServiceSkuOverridesByDataArea()["H007"].refund;

  const loopClosedBody = {
    id: "LOOP-952459295",
    topic: "return",
    trigger: "return.closed",
    state: "closed",
    provider_order_id: "6854207078567",
    refund: "39.99",
    currency: "USD",
    refunds: [{ provider_refund_id: 779952459295 }],
  };

  it("accepts return.closed payload with positive refund", () => {
    expect(isLoopReturnClosedPayload(loopClosedBody)).toBe(true);
    expect(loopClosedReturnRefundIsPositive(loopClosedBody)).toBe(true);
  });

  it("builds synthetic Shopify refund matching spock processLoopRefundOnly", () => {
    const synthetic = buildSyntheticShopifyRefundFromLoopReturn(loopClosedBody);
    expect(synthetic.transactions).toHaveLength(1);
    expect(synthetic.transactions[0].amount).toBe("39.99");
    expect(synthetic.transactions[0].gateway).toBe("loop_returns");
    expect(synthetic.transactions[0].receipt?.balance_transaction?.exchange_rate).toBe(1);
  });

  it("derives USD refund amount for D365 negative line (same as process-refund)", () => {
    const synthetic = buildSyntheticShopifyRefundFromLoopReturn(loopClosedBody);
    const breakdown = analyzeRefundAmount(synthetic);
    const resolved = resolveRefundAmountUsd({
      refundAmount: breakdown.amount,
      shopifyOrder: { currency: "USD", presentment_currency: "USD" },
      refund: synthetic,
    });
    expect(breakdown.amount).toBe(39.99);
    expect(resolved.refundAmountUsd).toBe(39.99);
    expect(resolved.conversionApplied).toBe(false);
  });

  it("posts H007 return fulfilment with explicit quarantine warehouse (HK lane)", () => {
    const returnCfg = getReturnConfig("HK Warehouse");
    expect(getRefundSku("HK Warehouse", "H007")).toBe(h007RefundSku);

    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "return",
      salesOrderNumber: "H007-SO-124143",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: h007RefundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "H007-392124",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).toMatchObject({
      ItemNumber: h007RefundSku,
      Quantity: -1,
      Warehouse: "OPS-WH01",
      Location: "Return",
    });
  });

  it("posts H007 GPS UK return fulfilment with OPS-WH02-Q", () => {
    const returnCfg = getReturnConfig("GPS UK Warehouse");
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "return",
      salesOrderNumber: "H007-SO-124142",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: h007RefundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "H007-392125",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).toMatchObject({
      Warehouse: "OPS-WH02-Q",
      Location: "Return",
    });
  });
});
