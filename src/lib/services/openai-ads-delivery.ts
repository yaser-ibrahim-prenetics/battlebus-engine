import {
  isRetryableOpenAiAdsError,
  openAiAdsConfigurationIssue,
  openAiAdsErrorCategory,
  openAiAdsErrorStatus,
  sanitizeOpenAiAdsError,
  sendOpenAiAdsOrderCreatedConversion,
} from "@/lib/clients/openai-ads";
import {
  markOpenAiAdsConversionDelivered,
  markOpenAiAdsConversionFailed,
  OPENAI_ADS_MAX_ATTEMPTS,
  openAiAdsRetryDelaySeconds,
  renewOpenAiAdsConversionClaim,
  type OpenAiAdsConversionClaim,
} from "@/lib/services/openai-ads-conversions";

type DeliveryDependencies = {
  configurationIssue: typeof openAiAdsConfigurationIssue;
  renew: typeof renewOpenAiAdsConversionClaim;
  send: typeof sendOpenAiAdsOrderCreatedConversion;
  markDelivered: typeof markOpenAiAdsConversionDelivered;
  markFailed: typeof markOpenAiAdsConversionFailed;
};

const defaultDependencies: DeliveryDependencies = {
  configurationIssue: openAiAdsConfigurationIssue,
  renew: renewOpenAiAdsConversionClaim,
  send: sendOpenAiAdsOrderCreatedConversion,
  markDelivered: markOpenAiAdsConversionDelivered,
  markFailed: markOpenAiAdsConversionFailed,
};

export type OpenAiAdsDeliveryOutcome = {
  eventId: string;
  status: "delivered" | "retry_wait" | "permanent_failure" | "stale";
  attempts: number;
  errorCategory?: string;
  retryAt?: string;
};

export async function deliverOpenAiAdsConversion(
  claim: OpenAiAdsConversionClaim,
  dependencies: DeliveryDependencies = defaultDependencies
): Promise<OpenAiAdsDeliveryOutcome> {
  const renewed = await dependencies.renew(claim);
  if (!renewed) {
    return { eventId: claim.eventId, status: "stale", attempts: claim.attempts };
  }

  const configurationIssue = dependencies.configurationIssue(claim.shopifyStore);
  if (configurationIssue) {
    await dependencies.markFailed({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      terminal: true,
      retryDelaySeconds: 0,
      category: configurationIssue,
      error: "OpenAI Ads delivery configuration is incomplete",
    });
    return {
      eventId: claim.eventId,
      status: "permanent_failure",
      attempts: claim.attempts,
      errorCategory: configurationIssue,
    };
  }

  try {
    const httpStatus = await dependencies.send({
      eventId: claim.eventId,
      occurredAt: claim.occurredAt,
      shopifyStore: claim.shopifyStore,
    });
    await dependencies.markDelivered({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      httpStatus,
    });
    return { eventId: claim.eventId, status: "delivered", attempts: claim.attempts };
  } catch (error) {
    const retryable = isRetryableOpenAiAdsError(error);
    const terminal = !retryable || claim.attempts >= OPENAI_ADS_MAX_ATTEMPTS;
    const category = openAiAdsErrorCategory(error);
    const transition = await dependencies.markFailed({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      httpStatus: openAiAdsErrorStatus(error),
      terminal,
      retryDelaySeconds: terminal ? 0 : openAiAdsRetryDelaySeconds(claim.attempts),
      category,
      error: sanitizeOpenAiAdsError(error),
    });
    return {
      eventId: claim.eventId,
      status: transition.status === "permanent_failure" ? "permanent_failure" : "retry_wait",
      attempts: claim.attempts,
      errorCategory: category,
      ...(transition.nextAttemptAt ? { retryAt: transition.nextAttemptAt } : {}),
    };
  }
}
