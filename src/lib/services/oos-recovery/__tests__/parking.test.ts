import { describe, expect, it } from "vitest";
import { buildOosParkedEvent } from "../parking";

describe("OOS parking event", () => {
  it("uses a stable identity and minimal recovery payload", () => {
    const params = {
      dependencies: [
        {
          provider: "gps" as const,
          warehouse: "JFK01W",
          sku: "SKU-1",
          orderLineId: "line-1",
          quantityNeeded: 2,
          shopifyOrderId: "42",
          shopifyOrderName: "IM8-42",
          shopifyStore: "im8health.myshopify.com",
          safeFailureCategory: "out_of_stock" as const,
        },
      ],
      context: { maxRetries: 7 },
      retentionDays: 30,
      now: new Date("2026-10-29T00:00:00.000Z"),
    };
    const first = buildOosParkedEvent(params);
    const second = buildOosParkedEvent({
      ...params,
      now: new Date("2026-10-30T00:00:00.000Z"),
    });
    expect(first.id).toBe(second.id);
    expect(first.data).toMatchObject({
      shopifyOrderId: "42",
      errorMessage: "Inventory dependency parked for targeted recovery",
      failedSkus: ["SKU-1"],
      failureSystem: "gps",
    });
    expect(JSON.stringify(first)).not.toContain("address");
  });

  it("rejects mixed orders", () => {
    expect(() =>
      buildOosParkedEvent({
        dependencies: [
          {
            provider: "gps",
            warehouse: "JFK01W",
            sku: "SKU-1",
            orderLineId: "1",
            quantityNeeded: 1,
            shopifyOrderId: "42",
            shopifyOrderName: "IM8-42",
            shopifyStore: "im8health.myshopify.com",
            safeFailureCategory: "out_of_stock",
          },
          {
            provider: "gps",
            warehouse: "JFK01W",
            sku: "SKU-2",
            orderLineId: "2",
            quantityNeeded: 1,
            shopifyOrderId: "43",
            shopifyOrderName: "IM8-43",
            shopifyStore: "im8health.myshopify.com",
            safeFailureCategory: "out_of_stock",
          },
        ],
        context: { maxRetries: 7 },
        retentionDays: 30,
      })
    ).toThrow("one Shopify order");
  });
});
