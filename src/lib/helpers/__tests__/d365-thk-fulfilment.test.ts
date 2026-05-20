import { describe, expect, it } from "vitest";
import {
  assertThkFulfilmentSucceeded,
  getThkFulfilmentBlockingIssue,
  getThkFulfilmentWarningMessage,
  isThkFulfilmentIncompleteError,
  isThkFulfilmentInformationalWarning,
} from "../d365-thk-fulfilment";

describe("d365-thk-fulfilment", () => {
  it("treats warehouse dimension messages as informational (success)", () => {
    const msg =
      " Dimension Warehouse is still specified on the inventory transaction with value USOPS-WH04";
    expect(isThkFulfilmentInformationalWarning(msg)).toBe(true);
    expect(getThkFulfilmentWarningMessage(msg)).toBe(msg.trim());
    expect(getThkFulfilmentBlockingIssue(msg)).toBeNull();
    expect(isThkFulfilmentIncompleteError(msg)).toBe(false);
    expect(() =>
      assertThkFulfilmentSucceeded({ Message: msg }, "U001-SO-563309")
    ).not.toThrow();
  });

  it("treats warehouse warning with journal voucher count as success", () => {
    const msg =
      " Dimension Warehouse is still specified on the inventory transaction with value USOPS-WH04 Number of vouchers posted to the journal: 1";
    expect(getThkFulfilmentBlockingIssue(msg)).toBeNull();
    expect(() =>
      assertThkFulfilmentSucceeded({ Message: msg }, "U001-SO-553687")
    ).not.toThrow();
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

  it("still blocks explicit invoice failure messages", () => {
    const msg = "Line could not be invoiced for item IM8-FG-000219";
    expect(getThkFulfilmentBlockingIssue(msg)).toBe("could not be invoiced");
    expect(() =>
      assertThkFulfilmentSucceeded({ Message: msg }, "H007-SO-119969")
    ).toThrow(/THK fulfilment incomplete for H007-SO-119969/);
  });

  it("does not throw for clean success messages", () => {
    expect(() =>
      assertThkFulfilmentSucceeded({ Message: "Success" }, "H007-SO-119969")
    ).not.toThrow();
  });
});
