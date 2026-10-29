import { describe, expect, it } from "vitest";
import { allocateOosOrders, oosInventoryKey, type OosDependencyRow } from "../drain";

function dependency(overrides: Partial<OosDependencyRow>): OosDependencyRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    orderId: "1",
    orderName: "IM8-1",
    orderLineId: "line-1",
    shopifyStore: "im8health.myshopify.com",
    provider: "gps",
    warehouse: "JFK01W",
    sku: "SKU-1",
    quantityNeeded: 1,
    failureCategory: "out_of_stock",
    d365OrderNumber: "U001-SO-1",
    failureStage: "order_creation",
    retryMode: "gps_outbound",
    backorderQueue: "sync",
    firstParkedAt: "2026-10-29T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("OOS FIFO allocation", () => {
  it("allocates oldest orders first without overselling", () => {
    const older = dependency({ quantityNeeded: 2 });
    const newer = dependency({
      id: "00000000-0000-0000-0000-000000000002",
      orderId: "2",
      orderName: "IM8-2",
      firstParkedAt: "2026-10-29T01:00:00.000Z",
      quantityNeeded: 2,
    });
    const decisions = allocateOosOrders(
      [newer, older],
      new Map([[oosInventoryKey(older), 3]]),
      10
    );
    expect(decisions.map(({ orderKey, selected }) => ({ orderKey, selected }))).toEqual([
      { orderKey: "im8health.myshopify.com:1", selected: true },
      { orderKey: "im8health.myshopify.com:2", selected: false },
    ]);
  });

  it("requires every blocked line before selecting an order", () => {
    const skuOne = dependency({ quantityNeeded: 1 });
    const skuTwo = dependency({
      id: "00000000-0000-0000-0000-000000000002",
      orderLineId: "line-2",
      sku: "SKU-2",
      quantityNeeded: 1,
    });
    const availability = new Map([
      [oosInventoryKey(skuOne), 1],
      [oosInventoryKey(skuTwo), 0],
    ]);
    expect(allocateOosOrders([skuOne, skuTwo], availability, 10)[0]).toMatchObject({
      selected: false,
      reason: "insufficient_inventory",
    });
  });

  it("never shares capacity across provider or warehouse keys", () => {
    const gps = dependency({ provider: "gps", warehouse: "JFK01W" });
    const d365 = dependency({
      id: "00000000-0000-0000-0000-000000000002",
      orderId: "2",
      provider: "d365",
      warehouse: "U001",
    });
    const decisions = allocateOosOrders(
      [gps, d365],
      new Map([
        [oosInventoryKey(gps), 1],
        [oosInventoryKey(d365), 0],
      ]),
      10
    );
    expect(decisions.map((decision) => decision.selected)).toEqual([true, false]);
  });

  it("uses a bounded order limit", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      dependency({
        id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
        orderId: String(index),
        orderName: `IM8-${index}`,
      })
    );
    expect(
      allocateOosOrders(rows, new Map([[oosInventoryKey(rows[0]), 10_000]]), 100)
    ).toHaveLength(100);
  });
});
