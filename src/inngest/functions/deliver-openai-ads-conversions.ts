import * as csPlatform from "@/lib/clients/cs-platform";
import {
  isRetryableOpenAiAdsError,
  openAiAdsErrorStatus,
  sanitizeOpenAiAdsError,
  sendOpenAiAdsOrderCreatedConversion,
} from "@/lib/clients/openai-ads";
import { config } from "@/lib/config";
import {
  claimOpenAiAdsConversions,
  markOpenAiAdsConversionDelivered,
  markOpenAiAdsConversionFailed,
} from "@/lib/services/openai-ads-conversions";
import { inngest } from "../client";

const MAX_DELIVERY_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export const deliverOpenAiAdsConversions = inngest.createFunction(
  {
    id: "deliver-openai-ads-conversions",
    name: "Deliver OpenAI Ads Conversions",
    retries: 2,
    concurrency: [{ limit: 3 }],
    triggers: [
      { event: "openai.ads/conversion.queued" },
      { event: "admin/openai-ads.redeliver" },
      { cron: "*/5 * * * *" },
    ],
  },
  async ({ event, step }: { event: any; step: any }) => {
    if (!config.openAiAds.enabled) return { status: "disabled" };

    const requestedEventId =
      event.name === "openai.ads/conversion.queued" || event.name === "admin/openai-ads.redeliver"
        ? String(event.data?.eventId || "")
        : undefined;
    const claims = await step.run("claim-openai-ads-conversions", () =>
      claimOpenAiAdsConversions({
        eventId: requestedEventId || undefined,
        limit: requestedEventId ? 1 : 25,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      })
    );

    const results: Array<{ eventId: string; state: string; attempts: number }> = [];
    for (const [index, claim] of claims.entries()) {
      const result = await step.run(`deliver-openai-ads-conversion-${index}`, async () => {
        try {
          const httpStatus = await sendOpenAiAdsOrderCreatedConversion({
            eventId: claim.eventId,
            occurredAt: claim.occurredAt,
          });
          await markOpenAiAdsConversionDelivered({
            eventId: claim.eventId,
            claimToken: claim.claimToken,
            httpStatus,
          });
          await csPlatform
            .sendOrderUpdate(
              {
                shopifyOrderId: claim.shopifyOrderId,
                shopifyOrderName: claim.shopifyOrderName,
                state: {
                  openAiAdsConversion: {
                    eventId: claim.eventId,
                    state: "delivered",
                    attempts: claim.attempts,
                  },
                },
              },
              {}
            )
            .catch((error) => console.warn("[OpenAI Ads] Hub update failed", error));
          return { eventId: claim.eventId, state: "delivered", attempts: claim.attempts };
        } catch (error) {
          const retryable = isRetryableOpenAiAdsError(error);
          const terminal = !retryable || claim.attempts >= MAX_DELIVERY_ATTEMPTS;
          const retryDelayMs = RETRY_DELAYS_MS[Math.max(0, claim.attempts - 1)] ?? 0;
          const sanitizedError = sanitizeOpenAiAdsError(error);
          await markOpenAiAdsConversionFailed({
            eventId: claim.eventId,
            claimToken: claim.claimToken,
            httpStatus: openAiAdsErrorStatus(error),
            terminal,
            retryDelayMs,
            error: sanitizedError,
          });
          const state = terminal ? "dead_letter" : "pending";
          await csPlatform
            .sendOrderUpdate(
              {
                shopifyOrderId: claim.shopifyOrderId,
                shopifyOrderName: claim.shopifyOrderName,
                state: {
                  openAiAdsConversion: {
                    eventId: claim.eventId,
                    state,
                    attempts: claim.attempts,
                    lastError: sanitizedError,
                  },
                },
              },
              {}
            )
            .catch((hubError) => console.warn("[OpenAI Ads] Hub update failed", hubError));
          return { eventId: claim.eventId, state, attempts: claim.attempts };
        }
      });
      results.push(result);
    }

    return { status: "processed", claimed: claims.length, results };
  }
);
