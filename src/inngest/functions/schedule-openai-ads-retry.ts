import { inngest } from "@/inngest/client";
import type { OpenAiAdsConversionRetryScheduledEvent } from "@/inngest/events";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { NonRetriableError } from "inngest";

type RetryScheduleStep = {
  sleepUntil(id: string, until: string): Promise<void>;
  sendEvent(
    id: string,
    event: { id: string; name: "openai.ads/conversion.queued"; data: { eventId: string } }
  ): Promise<unknown>;
};

export const scheduleOpenAiAdsRetry = inngest.createFunction(
  {
    id: "schedule-openai-ads-retry",
    name: "Schedule OpenAI Ads Conversion Retry",
    idempotency: "event.data.eventId + ':' + event.data.attempt",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 100 },
    triggers: [{ event: "openai.ads/conversion.retry-scheduled" }],
  },
  async ({
    event,
    step,
  }: {
    event: OpenAiAdsConversionRetryScheduledEvent;
    step: RetryScheduleStep;
  }) => {
    const retryAt = new Date(event.data.retryAt);
    if (Number.isNaN(retryAt.getTime())) {
      throw new NonRetriableError("Invalid OpenAI Ads retry timestamp");
    }
    await step.sleepUntil("wait-for-openai-ads-retry", retryAt.toISOString());
    await step.sendEvent("wake-openai-ads-retry", {
      id: `openai-ads-retry:${event.data.eventId}:${event.data.attempt}`,
      name: "openai.ads/conversion.queued",
      data: { eventId: event.data.eventId },
    });
    return {
      status: "woken",
      eventId: event.data.eventId,
      attempt: event.data.attempt,
      retryAt: retryAt.toISOString(),
    };
  }
);
