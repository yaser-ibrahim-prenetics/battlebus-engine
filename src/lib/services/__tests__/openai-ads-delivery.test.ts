import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiAdsDeliveryError } from "@/lib/clients/openai-ads";
import { deliverOpenAiAdsConversion } from "../openai-ads-delivery";
import type { OpenAiAdsConversionClaim } from "../openai-ads-conversions";

const claim: OpenAiAdsConversionClaim = {
  eventId: "bb_order_created_0000000000000000000000000000000000000000",
  shopifyStore: "store.myshopify.com",
  shopifyOrderId: "123",
  occurredAt: "2026-10-30T00:00:00.000Z",
  attempts: 1,
  leaseToken: "00000000-0000-4000-8000-000000000001",
  leaseUntil: "2026-10-30T00:02:00.000Z",
};

function dependencies() {
  return {
    configurationIssue: vi.fn((): string | null => null),
    renew: vi.fn(async () => true),
    send: vi.fn(async () => 202),
    markDelivered: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "retry_wait" as const),
  };
}

describe("OpenAI Ads conversion delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a confirmed provider response delivered", async () => {
    const deps = dependencies();
    await expect(deliverOpenAiAdsConversion(claim, deps)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
    });
    expect(deps.send).toHaveBeenCalledWith({
      eventId: claim.eventId,
      occurredAt: claim.occurredAt,
      shopifyStore: claim.shopifyStore,
    });
    expect(deps.markDelivered).toHaveBeenCalledWith({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      httpStatus: 202,
    });
  });

  it("performs no provider call after losing the lease", async () => {
    const deps = dependencies();
    deps.renew.mockResolvedValue(false);
    await expect(deliverOpenAiAdsConversion(claim, deps)).resolves.toMatchObject({
      status: "stale",
    });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("makes HTTP 400 permanent", async () => {
    const deps = dependencies();
    deps.send.mockRejectedValue(
      new OpenAiAdsDeliveryError("HTTP 400", "provider_rejected", false, 400)
    );
    deps.markFailed.mockResolvedValue("permanent_failure");

    await expect(deliverOpenAiAdsConversion(claim, deps)).resolves.toMatchObject({
      status: "permanent_failure",
      errorCategory: "provider_rejected",
    });
    expect(deps.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true, httpStatus: 400, retryDelaySeconds: 0 })
    );
  });

  it("backs off HTTP 429 and makes the sixth failure permanent", async () => {
    const rateLimited = new OpenAiAdsDeliveryError("HTTP 429", "rate_limited", true, 429);
    const retryDeps = dependencies();
    retryDeps.send.mockRejectedValue(rateLimited);
    await deliverOpenAiAdsConversion({ ...claim, attempts: 2 }, retryDeps);
    expect(retryDeps.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: false, retryDelaySeconds: 300 })
    );

    const terminalDeps = dependencies();
    terminalDeps.send.mockRejectedValue(rateLimited);
    terminalDeps.markFailed.mockResolvedValue("permanent_failure");
    await deliverOpenAiAdsConversion({ ...claim, attempts: 6 }, terminalDeps);
    expect(terminalDeps.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true, retryDelaySeconds: 0 })
    );
  });

  it("fails configuration issues before the provider call", async () => {
    const deps = dependencies();
    deps.configurationIssue.mockReturnValue("store_not_allowed");
    deps.markFailed.mockResolvedValue("permanent_failure");
    await expect(deliverOpenAiAdsConversion(claim, deps)).resolves.toMatchObject({
      status: "permanent_failure",
      errorCategory: "store_not_allowed",
    });
    expect(deps.send).not.toHaveBeenCalled();
  });
});
