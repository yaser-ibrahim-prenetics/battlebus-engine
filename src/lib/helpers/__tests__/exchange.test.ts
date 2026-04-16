import { describe, it, expect } from "vitest";
import {
  extractExchangeRateFromRefundReceipt,
  extractExchangeRateFromTransactions,
  getFallbackRate,
  convertToShopCurrency,
} from "../exchange";

describe("extractExchangeRateFromRefundReceipt", () => {
  it("prefers balance_transaction.exchange_rate from the refund receipt", () => {
    const rate = extractExchangeRateFromRefundReceipt({
      transactions: [
        {
          amount: "100.00",
          currency: "HKD",
          receipt: {
            balance_transaction: { exchange_rate: 0.1284 },
          },
        },
      ],
    });
    expect(rate).toEqual({
      from: "HKD",
      to: "USD",
      rate: 0.1284,
      source: "shopify_receipt",
    });
  });

  it("coerces string rates to numbers", () => {
    const rate = extractExchangeRateFromRefundReceipt({
      transactions: [
        {
          amount: "100.00",
          currency: "gbp",
          receipt: {
            balance_transaction: { exchange_rate: "1.27" },
          },
        },
      ],
    });
    expect(rate?.rate).toBeCloseTo(1.27);
    expect(rate?.from).toBe("GBP");
    expect(rate?.source).toBe("shopify_receipt");
  });

  it("skips transactions whose currency matches the shop currency", () => {
    const rate = extractExchangeRateFromRefundReceipt({
      transactions: [
        {
          amount: "20.00",
          currency: "USD",
          receipt: { balance_transaction: { exchange_rate: 1 } },
        },
      ],
    });
    expect(rate).toBeNull();
  });

  it("returns null when no receipt rate is present", () => {
    const rate = extractExchangeRateFromRefundReceipt({
      transactions: [
        {
          amount: "50.00",
          currency: "HKD",
          receipt: { balance_transaction: null },
        },
      ],
    });
    expect(rate).toBeNull();
  });

  it("ignores zero or negative rates", () => {
    const rate = extractExchangeRateFromRefundReceipt({
      transactions: [
        {
          amount: "10",
          currency: "JPY",
          receipt: { balance_transaction: { exchange_rate: 0 } },
        },
      ],
    });
    expect(rate).toBeNull();
  });
});

describe("FX priority integration (receipt → pair → fallback)", () => {
  function resolveRate(
    refund: { transactions: Array<{ amount: string; currency?: string; receipt?: any }> },
    orderTransactions: Array<{ amount: string; currency?: string }>,
    orderCurrency: string
  ) {
    return (
      extractExchangeRateFromRefundReceipt(refund, "USD") ||
      extractExchangeRateFromTransactions(orderTransactions, "USD") ||
      getFallbackRate(orderCurrency, "USD")
    );
  }

  it("uses the refund receipt rate when available", () => {
    const resolved = resolveRate(
      {
        transactions: [
          {
            amount: "50.00",
            currency: "HKD",
            receipt: { balance_transaction: { exchange_rate: 0.128 } },
          },
        ],
      },
      [
        { amount: "100.00", currency: "HKD" },
        { amount: "12.00", currency: "USD" },
      ],
      "HKD"
    );
    expect(resolved?.source).toBe("shopify_receipt");
    expect(resolved?.rate).toBe(0.128);
  });

  it("falls back to pair extraction when the refund carries no receipt rate", () => {
    const resolved = resolveRate(
      { transactions: [{ amount: "50.00", currency: "HKD", receipt: null }] },
      [
        { amount: "100.00", currency: "HKD" },
        { amount: "12.80", currency: "USD" },
      ],
      "HKD"
    );
    expect(resolved?.source).toBe("shopify_transaction");
    expect(resolved?.rate).toBeCloseTo(0.128);
  });

  it("falls back to static rates when neither receipt nor pair extraction works", () => {
    const resolved = resolveRate(
      { transactions: [{ amount: "50.00", currency: "HKD" }] },
      [{ amount: "100.00", currency: "HKD" }],
      "HKD"
    );
    expect(resolved?.source).toBe("fallback");
    expect(resolved?.from).toBe("HKD");
    expect(resolved?.to).toBe("USD");
  });

  it("converts amount using the receipt rate", () => {
    const resolved = resolveRate(
      {
        transactions: [
          {
            amount: "100.00",
            currency: "HKD",
            receipt: { balance_transaction: { exchange_rate: 0.128 } },
          },
        ],
      },
      [],
      "HKD"
    );
    expect(convertToShopCurrency(100, "HKD", resolved)).toBe(12.8);
  });
});
