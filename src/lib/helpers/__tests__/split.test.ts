import { describe, expect, it } from "vitest";

import {
  buildFulfillmentSegments,
  toShopifyFulfillmentOrderSplits,
} from "../split";

describe("buildFulfillmentSegments", () => {
  it("splits on per-unit value and can divide one line across segments", () => {
    const segments = buildFulfillmentSegments(
      [
        { id: 11, line_item_id: 101, quantity: 1 },
        { id: 12, line_item_id: 102, quantity: 2 },
      ],
      [
        { id: 101, price: "240" },
        { id: 102, price: "10" },
      ],
      250
    );

    expect(segments).toEqual([
      {
        index: 0,
        subtotal: 250,
        items: [
          {
            fulfillmentOrderLineItemId: "11",
            shopifyLineItemId: "101",
            quantity: 1,
            unitPrice: 240,
          },
          {
            fulfillmentOrderLineItemId: "12",
            shopifyLineItemId: "102",
            quantity: 1,
            unitPrice: 10,
          },
        ],
      },
      {
        index: 1,
        subtotal: 10,
        items: [
          {
            fulfillmentOrderLineItemId: "12",
            shopifyLineItemId: "102",
            quantity: 1,
            unitPrice: 10,
          },
        ],
      },
    ]);
  });

  it("creates every threshold segment instead of one midpoint split", () => {
    const segments = buildFulfillmentSegments(
      [{ id: 11, line_item_id: 101, quantity: 5 }],
      [{ id: 101, price: "100" }],
      200
    );

    expect(segments.map((segment) => segment.items[0].quantity)).toEqual([2, 2, 1]);
    expect(toShopifyFulfillmentOrderSplits(segments)).toEqual([
      {
        fulfillmentOrderLineItems: [
          {
            fulfillmentOrderLineItemId: "gid://shopify/FulfillmentOrderLineItem/11",
            quantity: 2,
          },
        ],
      },
      {
        fulfillmentOrderLineItems: [
          {
            fulfillmentOrderLineItemId: "gid://shopify/FulfillmentOrderLineItem/11",
            quantity: 2,
          },
        ],
      },
    ]);
  });

  it("keeps an oversized unit in its own segment", () => {
    const segments = buildFulfillmentSegments(
      [{ id: 11, line_item_id: 101, quantity: 2 }],
      [{ id: 101, price: "300" }],
      250
    );

    expect(segments.map((segment) => segment.subtotal)).toEqual([300, 300]);
  });

  it("rejects fulfillment lines missing from the Shopify order", () => {
    expect(() =>
      buildFulfillmentSegments([{ id: 11, line_item_id: 999, quantity: 1 }], [], 250)
    ).toThrow("unknown Shopify line 999");
  });
});
