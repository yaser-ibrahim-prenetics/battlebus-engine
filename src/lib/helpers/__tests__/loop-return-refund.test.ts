import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  buildSyntheticShopifyRefundFromLoopReturn,
  isLoopReturnClosedPayload,
  loopClosedReturnRefundIsPositive,
  verifyLoopWebhookSignature,
} from "../loop-return-refund";

describe("loop-return-refund helpers", () => {
  describe("verifyLoopWebhookSignature", () => {
    it("accepts matching spock-style SHA256 HMAC (UTF-8 body → base64)", () => {
      const key = "abcd";
      const raw = '{"id":"r1"}';
      const sig = createHmac("sha256", key).update(raw, "utf8").digest("base64");
      expect(verifyLoopWebhookSignature(raw, key, sig)).toBe(true);
      expect(verifyLoopWebhookSignature(raw, key, `${sig}x`)).toBe(false);
    });
  });

  describe("loopClosedReturnRefundIsPositive", () => {
    it("returns false for zero or missing refund", () => {
      expect(loopClosedReturnRefundIsPositive({ refund: "0" })).toBe(false);
      expect(loopClosedReturnRefundIsPositive({ refund: "0.00" })).toBe(false);
      expect(loopClosedReturnRefundIsPositive({})).toBe(false);
    });

    it("returns true when refund parses > 0", () => {
      expect(loopClosedReturnRefundIsPositive({ refund: "190.46" })).toBe(true);
    });
  });

  describe("isLoopReturnClosedPayload", () => {
    it("matches return.closed with required ids", () => {
      expect(
        isLoopReturnClosedPayload({
          id: "108646244",
          topic: "return",
          trigger: "return.closed",
          provider_order_id: "6854207078567",
          refund: "10",
        })
      ).toBe(true);
    });

    it("rejects intermediate triggers", () => {
      expect(
        isLoopReturnClosedPayload({
          id: "108646244",
          topic: "return",
          trigger: "return.updated",
          provider_order_id: "6854207078567",
        })
      ).toBe(false);
    });
  });

  describe("buildSyntheticShopifyRefundFromLoopReturn", () => {
    it("mirrors spock processLoopRefundOnly amounts and exchange_rate=1 receipt", () => {
      const synthetic = buildSyntheticShopifyRefundFromLoopReturn({
        id: "108646244",
        topic: "return",
        trigger: "return.closed",
        provider_order_id: "6854207078567",
        refund: "190.46",
        currency: "USD",
      });
      expect(synthetic.order_id).toBe(6854207078567);
      expect(synthetic.refund_line_items).toEqual([]);
      expect(synthetic.transactions).toHaveLength(1);
      expect(synthetic.transactions[0].amount).toBe("190.46");
      expect(synthetic.transactions[0].kind).toBe("refund");
      expect(synthetic.transactions[0].status).toBe("success");
      expect(synthetic.transactions[0].gateway).toBe("loop_returns");
      expect(synthetic.transactions[0].receipt?.balance_transaction?.exchange_rate).toBe(1);
    });
  });
});
