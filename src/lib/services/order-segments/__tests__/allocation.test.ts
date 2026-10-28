import { describe, expect, it } from "vitest";
import { allocateQuantities } from "../allocation";
import type { StoredPlan } from "../types";
const stored: StoredPlan = {
  plan: {
    version: 1,
    orderId: "1",
    orderName: "O1",
    inputHash: "hash",
    segments: [0, 1].map((index) => ({
      index,
      sourceFulfillmentOrderId: "source",
      locationId: "location",
      warehouse: "GPS Warehouse",
      dataAreaId: index ? "H007" : "U001",
      lines: [{ lineItemId: "line", quantity: 2, physical: true }],
    })),
  },
  progress: { "0": { fulfillmentOrderId: "fo0" }, "1": { fulfillmentOrderId: "fo1" } },
};
describe("combined partial segment fulfillment", () => {
  it("reserves each quantity exactly once across partial deliveries and retries", () => {
    const first = allocateQuantities(
      stored,
      "f1",
      ["fo1", "fo0"],
      { line: 3 },
      [],
      "h1",
      "2026-10-28"
    );
    expect(first.map((a) => a.quantities.line)).toEqual([2, 1]);
    expect(
      allocateQuantities(stored, "f1", ["fo0", "fo1"], { line: 3 }, first, "h1", "2026-10-28")
    ).toEqual(first);
    const second = allocateQuantities(
      stored,
      "f2",
      ["fo0", "fo1"],
      { line: 1 },
      first,
      "h2",
      "2026-10-28"
    );
    expect(second.map((a) => [a.segment_index, a.quantities.line, a.include_services])).toEqual([
      [1, 1, false],
    ]);
    expect(() =>
      allocateQuantities(
        stored,
        "f3",
        ["fo0", "fo1"],
        { line: 1 },
        [...first, ...second],
        "h3",
        "2026-10-28"
      )
    ).toThrow();
  });
  it("never borrows quantity from a fulfillment order absent from provider evidence", () => {
    expect(() =>
      allocateQuantities(stored, "f1", ["fo1"], { line: 3 }, [], "h1", "2026-10-28")
    ).toThrow();
  });
});
