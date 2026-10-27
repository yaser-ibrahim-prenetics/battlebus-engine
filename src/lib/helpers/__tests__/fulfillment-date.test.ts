import { describe, expect, it } from "vitest";
import { fulfillmentPostingDate } from "../fulfillment-date";

describe("immutable fulfillment posting dates", () => {
  it("normalizes Shopify timestamps to UTC while preserving GPS warehouse calendar dates", () => {
    expect(fulfillmentPostingDate("2026-10-26T23:30:00-04:00")).toBe("2026-10-27");
    expect(fulfillmentPostingDate("2026-10-26 23:30:00", "source")).toBe("2026-10-26");
    expect(fulfillmentPostingDate("2026-10-26T23:30:00-04:00", "source")).toBe("2026-10-26");
  });
  it.each([undefined, null, "", "not-a-date", "2026-02-30T12:00:00Z", "2026-10-26 invalid"])(
    "fails closed for missing or invalid source timestamp %s",
    (value) => {
      expect(() => fulfillmentPostingDate(value)).toThrow("valid source timestamp");
    }
  );
});
