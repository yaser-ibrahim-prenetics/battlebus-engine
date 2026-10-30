import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_options: unknown, handler: unknown) => handler,
  },
}));
vi.mock("@/lib/config", () => ({ config: { openAiAds: { enabled: true } } }));
vi.mock("@/lib/services/openai-ads-conversions", () => ({
  claimOpenAiAdsConversions: mocks.claim,
}));
vi.mock("@/lib/services/openai-ads-delivery", () => ({
  deliverOpenAiAdsConversion: mocks.deliver,
}));

import { deliverOpenAiAdsConversions } from "@/inngest/functions/deliver-openai-ads-conversions";
import { scheduleOpenAiAdsRetry } from "@/inngest/functions/schedule-openai-ads-retry";

type Handler = (input: {
  event: { id: string; data?: Record<string, unknown> };
  step: {
    run: <T>(id: string, handler: () => Promise<T>) => Promise<T>;
    sendEvent: ReturnType<typeof vi.fn>;
    sleepUntil?: ReturnType<typeof vi.fn>;
  };
}) => Promise<unknown>;

describe("OpenAI Ads durable retry scheduling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a scheduled event for the exact database retry timestamp", async () => {
    mocks.claim.mockResolvedValue([
      {
        eventId: "bb_order_created_0000000000000000000000000000000000000000",
        attempts: 1,
      },
    ]);
    mocks.deliver.mockResolvedValue({
      eventId: "bb_order_created_0000000000000000000000000000000000000000",
      attempts: 1,
      status: "retry_wait",
      retryAt: "2026-10-30T00:01:00.000Z",
    });
    const sendEvent = vi.fn();
    const run = async <T>(_id: string, handler: () => Promise<T>) => handler();

    await (deliverOpenAiAdsConversions as unknown as Handler)({
      event: { id: "delivery-run" },
      step: { run, sendEvent },
    });

    expect(sendEvent).toHaveBeenCalledWith(expect.stringContaining("schedule-bb_order_created_"), {
      id: "openai-ads-retry-scheduled:bb_order_created_0000000000000000000000000000000000000000:1",
      name: "openai.ads/conversion.retry-scheduled",
      data: {
        eventId: "bb_order_created_0000000000000000000000000000000000000000",
        attempt: 1,
        retryAt: "2026-10-30T00:01:00.000Z",
      },
    });
  });

  it("sleeps durably before waking the normal delivery worker", async () => {
    const sendEvent = vi.fn();
    const sleepUntil = vi.fn();

    await (scheduleOpenAiAdsRetry as unknown as Handler)({
      event: {
        id: "schedule-run",
        data: {
          eventId: "bb_order_created_0000000000000000000000000000000000000000",
          attempt: 1,
          retryAt: "2026-10-30T00:01:00.000Z",
        },
      },
      step: {
        run: async <T>(_id: string, handler: () => Promise<T>) => handler(),
        sendEvent,
        sleepUntil,
      },
    });

    expect(sleepUntil).toHaveBeenCalledWith(
      "wait-for-openai-ads-retry",
      "2026-10-30T00:01:00.000Z"
    );
    expect(sendEvent).toHaveBeenCalledWith("wake-openai-ads-retry", {
      id: "openai-ads-retry:bb_order_created_0000000000000000000000000000000000000000:1",
      name: "openai.ads/conversion.queued",
      data: { eventId: "bb_order_created_0000000000000000000000000000000000000000" },
    });
  });

  it("does not retry an invalid persisted retry timestamp", async () => {
    const step = {
      run: async <T>(_id: string, handler: () => Promise<T>) => handler(),
      sendEvent: vi.fn(),
      sleepUntil: vi.fn(),
    };

    await expect(
      (scheduleOpenAiAdsRetry as unknown as Handler)({
        event: {
          id: "invalid-schedule",
          data: {
            eventId: "bb_order_created_0000000000000000000000000000000000000000",
            attempt: 1,
            retryAt: "not-a-timestamp",
          },
        },
        step,
      })
    ).rejects.toMatchObject({ name: "NonRetriableError" });
    expect(step.sleepUntil).not.toHaveBeenCalled();
  });
});
