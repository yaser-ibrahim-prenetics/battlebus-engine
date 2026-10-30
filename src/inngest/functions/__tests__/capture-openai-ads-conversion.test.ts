import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  options: undefined as { idempotency?: string } | undefined,
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (options: { idempotency?: string }, handler: unknown) => {
      mocks.options = options;
      return handler;
    },
  },
}));
vi.mock("@/lib/services/openai-ads-conversions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/openai-ads-conversions")>();
  return { ...actual, enqueueOpenAiAdsConversion: mocks.enqueue };
});

import { captureOpenAiAdsConversion } from "@/inngest/functions/capture-openai-ads-conversion";
import { toCanonicalOpenAiAdsEventId } from "@/lib/helpers/openai-ads-identity";

type CaptureHandler = (input: {
  event: {
    name: "shopify/order.paid";
    data: {
      shopifyOrderId: string;
      shopifyOrderName: string;
      shopifyStore: string;
      openAiAdsConversionId: string;
      orderJson: { financial_status: string; processed_at: string };
      receivedAt: string;
    };
  };
  step: {
    run: <T>(id: string, handler: () => Promise<T>) => Promise<T>;
    sendEvent: ReturnType<typeof vi.fn>;
  };
}) => Promise<unknown>;

const store = "active.myshopify.com";
const eventId = toCanonicalOpenAiAdsEventId({ shopifyStore: store, shopifyOrderId: "123" });

function input(openAiAdsConversionId = eventId) {
  return {
    event: {
      name: "shopify/order.paid" as const,
      data: {
        shopifyOrderId: "123-rerun-456",
        originalShopifyOrderId: "123",
        shopifyOrderName: "#123",
        shopifyStore: store,
        openAiAdsConversionId,
        orderJson: {
          financial_status: "paid",
          processed_at: "2026-10-30T00:00:00.000Z",
        },
        receivedAt: "2026-10-30T00:00:00.000Z",
      },
    },
    step: {
      run: async <T>(_id: string, handler: () => Promise<T>) => handler(),
      sendEvent: vi.fn(),
    },
  };
}

describe("OpenAI Ads conversion capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue({
      eventId,
      status: "queued",
      attempts: 0,
      reason: null,
    });
  });

  it("uses the canonical conversion identity for Inngest idempotency", () => {
    expect(mocks.options?.idempotency).toBe("event.data.openAiAdsConversionId");
  });

  it("captures a rerun under the original canonical order identity", async () => {
    const request = input();
    await expect(
      (captureOpenAiAdsConversion as unknown as CaptureHandler)(request)
    ).resolves.toMatchObject({ status: "queued", eventId });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      shopifyStore: store,
      shopifyOrderId: "123",
      occurredAt: "2026-10-30T00:00:00.000Z",
    });
  });

  it("rejects a supplied identity that does not match the event", async () => {
    await expect(
      (captureOpenAiAdsConversion as unknown as CaptureHandler)(input("wrong"))
    ).rejects.toMatchObject({ name: "NonRetriableError" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
