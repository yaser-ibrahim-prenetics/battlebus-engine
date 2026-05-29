import { describe, expect, it, vi } from "vitest";
import {
  assertDepositShipmentThkInvoiced,
  assertThkFulfilmentSucceeded,
  getThkFulfilmentBlockingIssue,
  getThkFulfilmentWarningMessage,
  hasThkInvoiceVoucherPosted,
  isDepositFulfillmentOrder,
  isSalesOrderFullyInvoiced,
  isSalesOrderPartiallyInvoiced,
  isThkFulfilmentIncompleteError,
  isThkFulfilmentInformationalWarning,
} from "../d365-thk-fulfilment";

describe("d365-thk-fulfilment", () => {
  it("detects partially invoiced deposit orders", () => {
    expect(isSalesOrderPartiallyInvoiced("PartiallyInvoiced")).toBe(true);
    expect(
      isDepositFulfillmentOrder({
        depositFulfillment: "No",
        processingStatus: "PartiallyInvoiced",
      })
    ).toBe(true);
  });

  it("detects fully invoiced header status", () => {
    expect(isSalesOrderFullyInvoiced("Invoiced")).toBe(true);
    expect(isSalesOrderFullyInvoiced("PartiallyInvoiced")).toBe(false);
  });
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

  it("detects invoice voucher text in THK messages", () => {
    const withVoucher =
      " Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02 Number of vouchers posted to the journal: 1";
    const withoutVoucher =
      " Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02";
    expect(hasThkInvoiceVoucherPosted(withVoucher)).toBe(true);
    expect(hasThkInvoiceVoucherPosted(withoutVoucher)).toBe(false);
  });

  it("warns but does not fail deposit shipment when warehouse warning has no invoice voucher", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg =
      " Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02";
    expect(() => assertDepositShipmentThkInvoiced({ Message: msg }, "H007-SO-119969")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("warehouse/site dimension — fulfilment continues")
    );
    warnSpy.mockRestore();
  });

  it("allows deposit shipment when warehouse warning includes invoice voucher", () => {
    const msg =
      " Dimension Warehouse is still specified on the inventory transaction with value OPS-WH02 Number of vouchers posted to the journal: 1";
    expect(() =>
      assertDepositShipmentThkInvoiced({ Message: msg }, "H007-SO-117127")
    ).not.toThrow();
  });

  it("classifies missing deposit standard invoice errors as incomplete", () => {
    expect(
      isThkFulfilmentIncompleteError(
        "[D365] Deposit shipment missing Standard invoice for H007-SO-119969 (h007): SalesOrderProcessingStatus=PartiallyInvoiced"
      )
    ).toBe(true);
  });
});

describe("isSalesOrderFullyInvoiced", () => {
  it("treats PartiallyInvoiced as not fully invoiced", () => {
    expect(isSalesOrderFullyInvoiced("PartiallyInvoiced")).toBe(false);
  });

  it("treats Invoiced as fully invoiced", () => {
    expect(isSalesOrderFullyInvoiced("Invoiced")).toBe(true);
  });
});
