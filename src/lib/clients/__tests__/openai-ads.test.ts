import { describe, expect, it, vi } from "vitest";

import {
  isRetryableOpenAiAdsError,
  openAiAdsConfigurationIssue,
  OpenAiAdsDeliveryError,
  sanitizeOpenAiAdsError,
  sendOpenAiAdsOrderCreatedConversion,
  toOpenAiAdsTimestampMs,
  type OpenAiAdsConfiguration,
} from "../openai-ads";

const settings: OpenAiAdsConfiguration = {
  enabled: true,
  conversionsApiKey: "test-secret",
  pixelId: "pixel-1",
  allowedStore: "store.myshopify.com",
  endpoint: "https://bzr.openai.com",
  apiVersion: "v1",
  sourceUrl: "https://example.com/checkout",
};

describe("OpenAI Ads client", () => {
  it("sends only the stable event identity and timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const occurredAt = new Date().toISOString();

    await expect(
      sendOpenAiAdsOrderCreatedConversion(
        { eventId: "bb_order_created_123", occurredAt, shopifyStore: settings.allowedStore },
        settings,
        fetchMock
      )
    ).resolves.toBe(202);

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://bzr.openai.com/v1/events?pid=pixel-1");
    expect(request.redirect).toBe("error");
    expect(request.headers.Authorization).toBe("Bearer test-secret");
    const body = JSON.parse(request.body);
    expect(body.events[0]).toEqual({
      id: "bb_order_created_123",
      type: "order_created",
      timestamp_ms: Date.parse(occurredAt),
      source_url: "https://example.com/checkout",
      action_source: "web",
      data: { type: "contents" },
    });
    expect(JSON.stringify(body)).not.toContain("customer");
  });

  it.each([408, 429, 500, 503])("classifies HTTP %s as retryable", async (status) => {
    const request = sendOpenAiAdsOrderCreatedConversion(
      {
        eventId: "event",
        occurredAt: new Date().toISOString(),
        shopifyStore: settings.allowedStore,
      },
      settings,
      vi.fn().mockResolvedValue(new Response("ignored-sensitive-body", { status }))
    );
    await expect(request).rejects.toSatisfy(isRetryableOpenAiAdsError);
  });

  it("classifies HTTP 400 as permanent without reading the response", async () => {
    const request = sendOpenAiAdsOrderCreatedConversion(
      {
        eventId: "event",
        occurredAt: new Date().toISOString(),
        shopifyStore: settings.allowedStore,
      },
      settings,
      vi.fn().mockResolvedValue(new Response("customer@example.com", { status: 400 }))
    );
    await expect(request).rejects.toMatchObject({
      category: "provider_rejected",
      retryable: false,
      status: 400,
    });
  });

  it("rejects an endpoint that could receive the bearer credential", async () => {
    await expect(
      sendOpenAiAdsOrderCreatedConversion(
        {
          eventId: "event",
          occurredAt: new Date().toISOString(),
          shopifyStore: settings.allowedStore,
        },
        { ...settings, endpoint: "https://attacker.example" },
        vi.fn()
      )
    ).rejects.toMatchObject({ category: "endpoint_invalid", retryable: false });
  });

  it("reports disabled, incomplete and disallowed configurations", () => {
    expect(
      openAiAdsConfigurationIssue(settings.allowedStore, { ...settings, enabled: false })
    ).toBe("integration_disabled");
    expect(openAiAdsConfigurationIssue(settings.allowedStore, { ...settings, pixelId: "" })).toBe(
      "pixel_id_missing"
    );
    expect(openAiAdsConfigurationIssue("another.myshopify.com", settings)).toBe(
      "store_not_allowed"
    );
  });

  it("rejects stale timestamps and sanitizes diagnostics", () => {
    expect(() =>
      toOpenAiAdsTimestampMs(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString())
    ).toThrow(OpenAiAdsDeliveryError);
    expect(
      sanitizeOpenAiAdsError(
        new Error("Bearer top-secret customer@example.com?api_key=hidden\nprovider rejected")
      )
    ).toBe("Bearer [redacted] [redacted-email]?api_key=[redacted] provider rejected");
  });
});
