import { describe, expect, it } from "vitest";
import { compareFinancialLines } from "../financial-comparison";
const line = { company: "U001", item: "sku", currency: "USD", quantity: 2, amountCents: 1001 };
describe("independent D365 financial comparison", () => {
  it("allows multiple segment orders only when quantities and cents aggregate exactly", () => {
    expect(
      compareFinancialLines(
        [line],
        [
          { ...line, quantity: 1, amountCents: 500 },
          { ...line, quantity: 1, amountCents: 501 },
        ]
      )
    ).toEqual([]);
  });
  it("detects a wrong legal entity despite identical global totals", () => {
    expect(compareFinancialLines([line], [{ ...line, company: "H007" }])).toHaveLength(2);
  });
  it("detects one missing cent, changed quantities, and wrong currencies", () => {
    expect(compareFinancialLines([line], [{ ...line, amountCents: 1000 }])[0].issue).toBe("amount");
    expect(compareFinancialLines([line], [{ ...line, quantity: 1 }])[0].issue).toBe("quantity");
    expect(compareFinancialLines([line], [{ ...line, currency: "GBP" }])).toHaveLength(2);
  });
  it("refuses malformed evidence rather than comparing it as zero", () => {
    expect(() => compareFinancialLines([line], [{ ...line, quantity: NaN }])).toThrow();
  });
});
