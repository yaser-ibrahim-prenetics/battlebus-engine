import { describe, expect, it } from "vitest";

import {
  cancellationPendingActionData,
  fulfillmentPendingActionData,
} from "../pending-action-payloads";

describe("minimal pending action replay payloads", () => {
  it("keeps only cancellation fields used by the target handler", () => {
    expect(
      cancellationPendingActionData({
        shopifyOrderId: "1001",
        shopifyOrderName: "IM8-1001",
        cancelReason: "customer",
        shopifyStore: "us",
        customerEmail: "sensitive@example.com",
        orderJson: {
          financial_status: "paid",
          cancelled_at: "2026-10-29T00:00:00Z",
          shipping_address: {
            country_code: "US",
            address1: "sensitive address",
            phone: "sensitive phone",
          },
        },
      })
    ).toEqual({
      shopifyOrderId: "1001",
      shopifyOrderName: "IM8-1001",
      cancelReason: "customer",
      shopifyStore: "us",
      orderJson: {
        financial_status: "paid",
        cancelled_at: "2026-10-29T00:00:00Z",
        shipping_address: { country_code: "US" },
      },
    });
  });

  it("allowlists the fulfillment replay contract and drops unrelated fields", () => {
    const orderJson = {
      id: 1001,
      name: "IM8-1001",
      financial_status: "paid",
      fulfillment_status: "partial",
      email: "must-not-be-stored@example.com",
      shipping_address: {
        country_code: "US",
        address1: "must-not-be-stored",
        phone: "must-not-be-stored",
      },
      line_items: [{ id: 1, sku: "SKU-1", title: "not needed for replay" }],
    };
    const fulfillments = [
      {
        id: 2001,
        status: "success",
        created_at: "2026-10-29T00:00:00Z",
        tracking_company: "Carrier",
        tracking_number: "TRACK-1",
        tracking_url: "not needed for replay",
        location_id: 3001,
        note: "FulfillmentType: standard",
        line_items: [{ id: 1, quantity: 1, sku: "SKU-1", price: "10.00", title: "not needed" }],
      },
    ];
    expect(
      fulfillmentPendingActionData({
        shopifyOrderId: "1001",
        shopifyOrderName: "IM8-1001",
        shopifyStore: "us",
        orderJson,
        fulfillments,
        fromGpsSync: true,
        gpsOrderId: "GPS-1",
        runSequence: ["warehouse", "d365"],
        accessToken: "must-not-be-stored",
        webhookHeaders: { authorization: "must-not-be-stored" },
      })
    ).toEqual({
      shopifyOrderId: "1001",
      shopifyOrderName: "IM8-1001",
      shopifyStore: "us",
      orderJson: {
        id: 1001,
        name: "IM8-1001",
        financial_status: "paid",
        fulfillment_status: "partial",
        shipping_address: { country_code: "US" },
        line_items: [{ id: 1, sku: "SKU-1" }],
      },
      fulfillments: [
        {
          id: 2001,
          status: "success",
          created_at: "2026-10-29T00:00:00Z",
          tracking_company: "Carrier",
          tracking_number: "TRACK-1",
          location_id: 3001,
          note: "FulfillmentType: standard",
          line_items: [{ id: 1, quantity: 1, sku: "SKU-1", price: "10.00" }],
        },
      ],
      fromGpsSync: true,
      gpsOrderId: "GPS-1",
      runSequence: ["warehouse", "d365"],
    });
  });
});
