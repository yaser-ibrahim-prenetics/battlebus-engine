import { inngest } from "@/inngest/client";
import type { ShopifyOrderPaidEvent, SubscriptionRenewalEvent } from "@/inngest/events";
import { NonRetriableError } from "inngest";

import { toCanonicalOpenAiAdsEventId } from "@/lib/helpers/openai-ads-identity";
import {
  enqueueOpenAiAdsConversion,
  normalizeOpenAiAdsShopifyStore,
  OpenAiAdsConversionValidationError,
} from "@/lib/services/openai-ads-conversions";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

type CaptureStep = {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
  sendEvent(
    id: string,
    event: { id: string; name: "openai.ads/conversion.queued"; data: { eventId: string } }
  ): Promise<unknown>;
};

type CaptureEvent = ShopifyOrderPaidEvent | SubscriptionRenewalEvent;

export const captureOpenAiAdsConversion = inngest.createFunction(
  {
    id: "capture-openai-ads-conversion",
    name: "Capture OpenAI Ads Conversion",
    idempotency: "event.data.openAiAdsConversionId",
    retries: RETRY_CONFIGS.DEFAULT,
    concurrency: { limit: 20 },
    triggers: [{ event: "shopify/order.paid" }, { event: "shopify/subscription.renewed" }],
  },
  async ({ event, step }: { event: CaptureEvent; step: CaptureStep }) => {
    const order = event.data?.orderJson;
    if (event.data?.testMode === true) return { status: "ineligible", reason: "test_mode" };
    if (String(order?.financial_status || "").toLowerCase() !== "paid") {
      return { status: "ineligible", reason: "not_paid" };
    }

    const shopifyStore = normalizeOpenAiAdsShopifyStore(event.data.shopifyStore);
    const shopifyOrderId = String(
      event.data.originalShopifyOrderId ||
        String(event.data.shopifyOrderId || "").split("-rerun-")[0]
    );
    const expectedEventId = toCanonicalOpenAiAdsEventId({
      shopifyStore,
      shopifyOrderId,
    });
    if (event.data.openAiAdsConversionId !== expectedEventId) {
      throw new NonRetriableError("OpenAI Ads conversion identity does not match event data");
    }
    const occurredAt = String(
      order?.processed_at || order?.created_at || event.data.receivedAt || ""
    );
    const conversion = await step.run("persist-openai-ads-conversion", async () => {
      try {
        return await enqueueOpenAiAdsConversion({ shopifyStore, shopifyOrderId, occurredAt });
      } catch (error) {
        if (error instanceof OpenAiAdsConversionValidationError) {
          throw new NonRetriableError(error.message);
        }
        throw error;
      }
    });

    if (conversion.status === "queued") {
      await step.sendEvent("wake-openai-ads-delivery", {
        id: `openai-ads:${conversion.eventId}`,
        name: "openai.ads/conversion.queued",
        data: { eventId: conversion.eventId },
      });
    }

    return {
      status: conversion.status,
      eventId: conversion.eventId,
      reason: conversion.reason,
    };
  }
);
