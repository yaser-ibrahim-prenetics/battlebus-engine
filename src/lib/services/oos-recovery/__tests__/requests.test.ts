import { describe, expect, it } from "vitest";
import { normalizeOosDrainRequest, oosDrainLaneKey } from "../requests";

describe("OOS drain request validation", () => {
  it("normalizes canonical keyed lanes and separates dry runs", () => {
    const input = {
      mode: "inventory_event" as const,
      dryRun: false,
      provider: "gps" as const,
      warehouse: " jfk01w ",
      sku: " sku-1 ",
      observedQuantity: 4,
      observedAt: "2026-10-29T01:02:03Z",
      sourceEventId: "inventory-1",
      batchLimit: 100,
    };
    expect(normalizeOosDrainRequest(input)).toMatchObject({
      warehouse: "JFK01W",
      sku: "SKU-1",
      observedAt: "2026-10-29T01:02:03.000Z",
    });
    expect(oosDrainLaneKey(input)).toBe("live:inventory:gps:JFK01W:SKU-1");
    expect(oosDrainLaneKey({ ...input, dryRun: true })).toBe(
      "dry:inventory:gps:JFK01W:SKU-1"
    );
  });

  it("supports targeted order and bounded sweep requests", () => {
    expect(
      oosDrainLaneKey({
        mode: "manual",
        dryRun: false,
        orderId: "42",
        shopifyStore: "IM8HEALTH.MYSHOPIFY.COM",
        batchLimit: 1,
      })
    ).toBe("live:order:im8health.myshopify.com:42");
    expect(oosDrainLaneKey({ mode: "sweep", dryRun: true, batchLimit: 1000 })).toBe(
      "dry:sweep"
    );
  });

  it("rejects partial keys and invalid ranges", () => {
    expect(() =>
      normalizeOosDrainRequest({
        mode: "manual",
        dryRun: false,
        provider: "gps",
        sku: "SKU-1",
        batchLimit: 10,
      })
    ).toThrow("provider, warehouse and SKU together");
    expect(() =>
      normalizeOosDrainRequest({
        mode: "sweep",
        dryRun: false,
        parkedFrom: "2026-10-30T00:00:00Z",
        parkedTo: "2026-10-29T00:00:00Z",
        batchLimit: 10,
      })
    ).toThrow("parkedFrom");
  });
});
