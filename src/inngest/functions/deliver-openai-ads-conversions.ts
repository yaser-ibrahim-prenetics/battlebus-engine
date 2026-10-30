import { config } from "@/lib/config";
import type {
  OpenAiAdsConversionQueuedEvent,
  OpenAiAdsConversionRetryScheduledEvent,
} from "@/inngest/events";
import { deliverOpenAiAdsConversion } from "@/lib/services/openai-ads-delivery";
import { claimOpenAiAdsConversions } from "@/lib/services/openai-ads-conversions";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { inngest } from "@/inngest/client";

type DeliveryStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
  sendEvent(
    id: string,
    event: { id: string } & (
      | OpenAiAdsConversionQueuedEvent
      | OpenAiAdsConversionRetryScheduledEvent
    )
  ): Promise<unknown>;
};

export const deliverOpenAiAdsConversions = inngest.createFunction(
  {
    id: "deliver-openai-ads-conversions",
    name: "Deliver OpenAI Ads Conversions",
    retries: RETRY_CONFIGS.LOW_PRIORITY,
    concurrency: { limit: 3 },
    triggers: [{ event: "openai.ads/conversion.queued" }, { cron: "*/5 * * * *" }],
  },
  async ({ event, step }: { event: { id: string }; step: DeliveryStep }) => {
    if (!config.openAiAds.enabled) return { status: "disabled", count: 0 };

    const claims = await step.run("claim-openai-ads-conversions", () =>
      claimOpenAiAdsConversions({ limit: 25, leaseSeconds: 120 })
    );
    const outcomes = [];
    for (const claim of claims) {
      outcomes.push(
        await step.run(`deliver-${claim.eventId}-attempt-${claim.attempts}`, () =>
          deliverOpenAiAdsConversion(claim)
        )
      );
    }

    for (const outcome of outcomes) {
      if (outcome.status !== "retry_wait") continue;
      if (!outcome.retryAt) throw new Error("OpenAI Ads retry transition has no wake time");
      await step.sendEvent(`schedule-${outcome.eventId}-attempt-${outcome.attempts}`, {
        id: `openai-ads-retry-scheduled:${outcome.eventId}:${outcome.attempts}`,
        name: "openai.ads/conversion.retry-scheduled",
        data: {
          eventId: outcome.eventId,
          attempt: outcome.attempts,
          retryAt: outcome.retryAt,
        },
      });
    }

    if (claims.length === 25) {
      const last = claims.at(-1);
      await step.sendEvent("continue-openai-ads-delivery", {
        id: `openai-ads-continue:${event.id}:${last?.eventId ?? "batch"}`,
        name: "openai.ads/conversion.queued",
        data: { eventId: last?.eventId ?? "batch" },
      });
    }

    return {
      status: claims.length ? "processed" : "idle",
      count: claims.length,
      delivered: outcomes.filter((outcome) => outcome.status === "delivered").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      retrying: outcomes.filter((outcome) => outcome.status === "retry_wait").length,
      permanentFailures: outcomes.filter((outcome) => outcome.status === "permanent_failure")
        .length,
      stale: outcomes.filter((outcome) => outcome.status === "stale").length,
    };
  }
);
