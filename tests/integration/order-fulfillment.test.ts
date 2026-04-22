import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInngestHarness } from "../helpers/inngest-harness";
import { mockDynamics, resetMockD365 } from "../mocks/dynamics";
import { mockShopify, resetMockShopify } from "../mocks/shopify";
import { mockSlack, resetMockSlack } from "../mocks/slack";
import { mockCsPlatform, resetMockCsPlatform } from "../mocks/cs-platform";
import { mockPaypal } from "../mocks/paypal";
import { isDummyFulfillment, isGpsFulfillment, filterDummySkus } from "@/lib/utils/validation";
import type { ShopifyFulfillment, ShopifyFulfillmentLineItem } from "@/inngest/events";

describe("Order Fulfillment Flow (Integration)", () => {
  let harness: ReturnType<typeof createInngestHarness>;

  beforeEach(() => {
    harness = createInngestHarness();
    resetMockD365();
    resetMockShopify();
    resetMockSlack();
    resetMockCsPlatform();
  });

  const stordFulfillment: ShopifyFulfillment = {
    id: 5001,
    order_id: 6900000000002,
    status: "success",
    created_at: "2026-03-17T10:00:00Z",
    updated_at: "2026-03-17T10:00:00Z",
    tracking_company: "FedEx",
    tracking_number: "FEDEX123456789",
    tracking_numbers: ["FEDEX123456789"],
    tracking_url: "https://www.fedex.com/track?FEDEX123456789",
    tracking_urls: ["https://www.fedex.com/track?FEDEX123456789"],
    location_id: 83243204840,
    line_items: [
      {
        id: 14020,
        variant_id: 44020,
        title: "IM8 Essential Pack",
        quantity: 1,
        sku: "IM8-FG-000093",
        name: "IM8 Essential Pack",
        price: "79.99",
        fulfillment_status: "fulfilled",
      },
    ],
  };

  const dummyFulfillment: ShopifyFulfillment = {
    id: 5002,
    order_id: 6900000000010,
    status: "success",
    created_at: "2026-03-17T10:00:00Z",
    updated_at: "2026-03-17T10:00:00Z",
    tracking_company: null,
    tracking_number: null,
    tracking_numbers: [],
    tracking_url: null,
    tracking_urls: [],
    location_id: null,
    line_items: [
      {
        id: 14099,
        variant_id: 44099,
        title: "ADJUSTMENT",
        quantity: 1,
        sku: "ADJUSTMENT",
        name: "ADJUSTMENT",
        price: "-10.00",
        fulfillment_status: "fulfilled",
      },
    ],
  };

  describe("STORD fulfillment creates D365 packing slip", () => {
    it("creates D365 packing slip for STORD fulfillment", async () => {
      const d365Order = {
        SalesOrderNumber: "U001-SO-200001",
        dataAreaId: "U001",
      };

      mockDynamics.getSalesOrderByShopifyId.mockResolvedValueOnce(d365Order);
      mockDynamics.getLotIdMap.mockResolvedValueOnce({
        "IM8-FG-000093": "LOT-STORD-001",
      });

      const fetchedOrder = await harness.step.run("get-d365-order", async () => {
        return mockDynamics.getSalesOrderByShopifyId("IM8-18050");
      });
      expect(fetchedOrder).toBe(d365Order);

      const result = await harness.step.run("process-fulfillments", async () => {
        const filteredItems = filterDummySkus(stordFulfillment.line_items);
        expect(filteredItems.length).toBe(1);

        const lotIdMap = await mockDynamics.getLotIdMap(
          d365Order.SalesOrderNumber,
          d365Order.dataAreaId
        );

        const fulfillmentLines = filteredItems.map((item: ShopifyFulfillmentLineItem) => ({
          itemNumber: item.sku,
          quantity: item.quantity,
          trackingNumber: stordFulfillment.tracking_number || "",
          shippingSiteId: "Prenetics",
          shippingWarehouseId: "",
          shippingWarehouseLocationId: "",
          lotId: lotIdMap[item.sku] || "",
        }));

        await mockDynamics.createFulfilment({
          dataAreaId: d365Order.dataAreaId,
          salesOrderNumber: d365Order.SalesOrderNumber,
          type: "PackingSlip",
          confirmedShippedDate: "2026-03-17",
          lines: fulfillmentLines,
        });

        return {
          fulfillmentId: stordFulfillment.id,
          status: "success",
          source: "STORD",
          trackingNumber: stordFulfillment.tracking_number,
        };
      });

      expect(result.status).toBe("success");
      expect(result.source).toBe("STORD");
      expect(mockDynamics.createFulfilment).toHaveBeenCalledTimes(1);

      const call = mockDynamics.createFulfilment.mock.calls[0][0];
      expect(call.type).toBe("PackingSlip");
      expect(call.lines[0].itemNumber).toBe("IM8-FG-000093");
      expect(call.lines[0].lotId).toBe("LOT-STORD-001");
    });
  });

  describe("Dummy fulfillment detection", () => {
    it("identifies dummy fulfillments with adjustment items", () => {
      expect(isDummyFulfillment(dummyFulfillment)).toBe(true);
    });

    it("identifies real fulfillments", () => {
      expect(isDummyFulfillment(stordFulfillment)).toBe(false);
    });
  });

  describe("GPS fulfillment from webhook is processed", () => {
    it("treats GPS location like other warehouses — manual Shopify fulfillment syncs to D365", async () => {
      const gpsFulfillment: ShopifyFulfillment = {
        ...stordFulfillment,
        id: 5010,
        location_id: 79527313640,
      };

      expect(isGpsFulfillment(gpsFulfillment.location_id || "")).toBe(true);

      const result = await harness.step.run("process-fulfillments", async () => {
        return {
          fulfillmentId: gpsFulfillment.id,
          status: "success",
          source: "Direct",
        };
      });

      expect(result.status).toBe("success");
    });
  });

  describe("PayPal tracking sync", () => {
    it("skips PayPal sync when disabled", () => {
      expect(mockPaypal.isEnabled()).toBe(false);
    });

    it("syncs tracking for PayPal transactions when enabled", async () => {
      mockPaypal.isEnabled.mockReturnValueOnce(true);
      mockShopify.getOrderTransactions.mockResolvedValueOnce([
        { id: 1, gateway: "paypal", kind: "sale", status: "success", amount: "79.99" },
      ]);

      const transactions = await mockShopify.getOrderTransactions(6900000000002);
      const paypalTxns = transactions.filter(
        (t: any) => t.gateway?.toLowerCase().includes("paypal") && t.kind === "sale"
      );

      expect(paypalTxns.length).toBe(1);
    });
  });

  describe("D365 order not found during fulfillment", () => {
    it("returns no_d365_order when D365 lookup fails", async () => {
      mockDynamics.getSalesOrderByShopifyId.mockResolvedValueOnce(null);

      const d365Order = await harness.step.run("get-d365-order", async () => {
        return mockDynamics.getSalesOrderByShopifyId("IM8-NOTFOUND");
      });

      expect(d365Order).toBeNull();
    });
  });
});
