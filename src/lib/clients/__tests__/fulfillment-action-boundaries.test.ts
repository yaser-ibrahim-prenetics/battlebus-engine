import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({
  execute: vi.fn(async (_identity, _request, operation) => operation()),
}));
vi.mock("@/lib/services/fulfillment-actions/ledger", () => ({
  executeFulfillmentAction: execute,
  ConfirmedActionFailure: class extends Error {},
}));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));
import type { GpsOrderData } from "../gps";
import type { D365FulfilmentRequest } from "@/lib/types/dynamics";
const gpsOrder: GpsOrderData = {
  platformOrderNo: "IM8-test",
  thirdOrderNo: "SO-1",
  whCode: "JFK01W",
  subOrderType: 1,
  logisticsChannel: "test",
  receiver: "Synthetic",
  addressOne: "Test",
  cityName: "Test",
  countryRegionCode: "US",
  postCode: "10001",
  productList: [{ sku: "SKU", quantity: 1 }],
};
const fulfillment: D365FulfilmentRequest = {
  fulfillmentId: "shopify:1",
  salesOrderNumber: "SO-1",
  dataAreaId: "U001",
  type: "shipment",
  confirmedShippedDate: "2026-10-20",
  lines: [{ itemNumber: "SKU", lotId: "LOT-1", quantity: 1, shippingSiteId: "U001" }],
};
beforeEach(() => {
  vi.resetModules();
  execute.mockClear();
  vi.stubEnv("OMS_MIN_INTERVAL_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("fulfillment mutation boundaries", () => {
  it.each(["timeout", "http500", "invalid-json", "missing-identifier"])(
    "does not retry GPS on %s",
    async (failure) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "timeout") throw new Error("timeout");
        if (failure === "http500") return new Response("error", { status: 500 });
        if (failure === "invalid-json") return new Response("bad json");
        return Response.json({ code: 200, data: [] });
      });
      const { createOutboundOrder } = await import("../gps");
      await expect(createOutboundOrder(gpsOrder)).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("reserves a separate attempt before a confirmed channel fallback", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ code: 200, data: [{ success: false, msg: "invalid logistics channel" }] })
      )
      .mockResolvedValueOnce(
        Response.json({ code: 200, data: [{ success: true, orderNo: "GPS-1" }] })
      );
    const { createOutboundOrder } = await import("../gps");
    expect((await createOutboundOrder(gpsOrder)).response.data[0].orderNo).toBe("GPS-1");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).data[0].logisticsChannel).toBe(
      "No_Shipping_Service"
    );
  });

  it("does not retry D365 partial/fully-invoiced/over-quantity errors", async () => {
    const { postDurableFulfilment } = await import("../dynamics/fulfillment");
    for (const Message of ["partially invoiced SKU", "fully invoiced", "over qty"]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ status: 0, Message }));
      await expect(
        postDurableFulfilment(fulfillment, { authenticate: async () => "token", fetch })
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves confirmed D365 inventory failures with their exact request lines", async () => {
    const { postDurableFulfilment } = await import("../dynamics/fulfillment");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { status: 0, Message: "Inventory insufficient; item number does not exist" },
          { status: 409 }
        )
      );
    const request = {
      ...fulfillment,
      lines: [
        {
          ...fulfillment.lines[0],
          sourceLineId: "shopify-line-1001",
          itemNumber: "sku-exact",
          quantity: 2,
          shippingWarehouseId: "WH-EXACT",
        },
      ],
    };

    await expect(
      postDurableFulfilment(request, { authenticate: async () => "token", fetch })
    ).rejects.toMatchObject({
      name: "InventoryUnavailableError",
      provider: "d365",
      category: "item_not_found",
      providerOrderNumber: "SO-1",
      providerWarehouse: "WH-EXACT",
      blockedItems: [
        {
          provider: "d365",
          warehouse: "WH-EXACT",
          sku: "SKU-EXACT",
          orderLineId: "shopify-line-1001",
          quantityNeeded: 2,
        },
      ],
    });
  });

  it("keeps stable source IDs distinct and supplies a shared tracking alias", async () => {
    const { postDurableFulfilment } = await import("../dynamics/fulfillment");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ status: 1, Message: "ok", Result: "PS-1", $id: "1" })
      );
    const tracked = {
      ...fulfillment,
      lines: [{ ...fulfillment.lines[0], trackingNumber: "TRACK-1" }],
    };
    await postDurableFulfilment(tracked, { authenticate: async () => "token", fetch });
    await postDurableFulfilment(
      { ...tracked, fulfillmentId: "gps:2" },
      { authenticate: async () => "token", fetch }
    );
    expect(execute.mock.calls[0][0].action).not.toEqual(execute.mock.calls[1][0].action);
    expect(execute.mock.calls[0][0].aliases).toEqual(execute.mock.calls[1][0].aliases);
    expect(execute.mock.calls[0][1]).toEqual(execute.mock.calls[1][1]);
  });
});
