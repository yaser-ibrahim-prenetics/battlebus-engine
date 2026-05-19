import { describe, expect, it } from "vitest";
import {
  resolveFulfilmentLane,
  resolveGpsOutboundFromRow,
  resolveSyncLane,
} from "../recovery-lane";

describe("recovery-lane routing", () => {
  it("routes missing hub order to shopify recover on sync", () => {
    expect(resolveSyncLane(null, "IM8-1")).toEqual({
      lane: "sync_shopify_recover",
      reason: "order_missing_in_hub",
    });
  });

  it("routes hub order without D365 to order.paid on sync", () => {
    expect(
      resolveSyncLane(
        { shopify_order_name: "IM8-2", d365_order_number: "" },
        "IM8-2"
      )
    ).toEqual({
      lane: "sync_order_paid",
      reason: "missing_d365_sales_order",
    });
  });

  it("routes GPS warehouse to gps_fulfilment", () => {
    expect(
      resolveFulfilmentLane(
        {
          warehouse: "GPS Warehouse",
          gps_order_no: "OBS123",
          shopify_fulfillment_status: null,
        },
        "IM8-3"
      ).lane
    ).toBe("gps_fulfilment");
  });

  it("skips GPS fulfilment when no outbound id", () => {
    expect(
      resolveFulfilmentLane(
        { warehouse: "GPS UK Warehouse", gps_uk_order_no: "" },
        "IM8-4"
      )
    ).toEqual({ lane: "skipped", reason: "gps_no_outbound_id" });
  });

  it("routes Stord to stord_fulfilment replay", () => {
    expect(
      resolveFulfilmentLane(
        {
          warehouse: "STORD ATL Location",
          shopify_fulfillment_status: null,
        },
        "IM8-5"
      ).lane
    ).toBe("stord_fulfilment");
  });

  it("routes HK warehouse to dynamics_shopify_mirror", () => {
    expect(
      resolveFulfilmentLane(
        { warehouse: "HK Warehouse", shopify_fulfillment_status: null },
        "IM8-6"
      ).lane
    ).toBe("dynamics_shopify_mirror");
  });

  it("resolveGpsOutboundFromRow picks UK id for UK warehouse", () => {
    expect(
      resolveGpsOutboundFromRow({
        warehouse: "GPS UK Warehouse",
        gps_uk_order_no: "OBS-UK-1",
        gps_order_no: "OBS-US-1",
      })
    ).toEqual({
      outboundId: "OBS-UK-1",
      warehouseName: "GPS UK Warehouse",
    });
  });
});
