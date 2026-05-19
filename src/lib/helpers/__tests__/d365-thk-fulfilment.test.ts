import { describe, expect, it } from "vitest";
import {
  assertThkFulfilmentSucceeded,
  getThkFulfilmentBlockingIssue,
  isThkFulfilmentIncompleteError,
} from "../d365-thk-fulfilment";

describe("d365-thk-fulfilment", () => {
  it("detects warehouse dimension blocking messages", () => {
    const msg =
      " Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02";
    expect(getThkFulfilmentBlockingIssue(msg)).toBe(
      "dimension warehouse is still specified"
    );
    expect(isThkFulfilmentIncompleteError(msg)).toBe(true);
  });

  it("treats empty and idempotent messages as non-blocking", () => {
    expect(getThkFulfilmentBlockingIssue("")).toBeNull();
    expect(getThkFulfilmentBlockingIssue("FULFILMENT_ALREADY_PROCESSED")).toBeNull();
    expect(
      getThkFulfilmentBlockingIssue(
        "Number of vouchers posted to the journal: 1"
      )
    ).toBeNull();
  });

  it("throws assertThkFulfilmentSucceeded for blocking warehouse warnings", () => {
    expect(() =>
      assertThkFulfilmentSucceeded(
        {
          Message:
            " Dimension Warehouse is still specified on the inventory transaction with value USOPS-WH04",
        },
        "U001-SO-553687"
      )
    ).toThrow(/THK fulfilment incomplete for U001-SO-553687/);
  });

  it("does not throw for clean success messages", () => {
    expect(() =>
      assertThkFulfilmentSucceeded({ Message: "Success" }, "H007-SO-119969")
    ).not.toThrow();
  });
});
