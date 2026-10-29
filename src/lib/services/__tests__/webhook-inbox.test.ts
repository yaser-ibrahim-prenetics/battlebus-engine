import { describe, expect, it } from "vitest";

import {
  classifyWebhookInboxDeliveryFailure,
  fingerprintWebhookPayload,
  validateWebhookInboxEvents,
  webhookInboxRetryDelaySeconds,
} from "../webhook-inbox";

describe("webhook inbox delivery policy", () => {
  it("persists a content fingerprint instead of the raw provider payload", () => {
    const fingerprint = fingerprintWebhookPayload({
      customer: { email: "private@example.com" },
      token: "secret-token",
    });

    expect(fingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(fingerprint)).not.toContain("private@example.com");
    expect(JSON.stringify(fingerprint)).not.toContain("secret-token");
  });

  it("requires stable, bounded event identities", () => {
    expect(
      validateWebhookInboxEvents([
        { id: "shopify-order-1", name: "shopify/order.paid", data: { orderId: "1" } },
      ])
    ).toBeNull();
    expect(
      validateWebhookInboxEvents([{ name: "shopify/order.paid", data: { orderId: "1" } }] as never)
    ).toBe("invalid_stable_event_identity");
    expect(
      validateWebhookInboxEvents(
        Array.from({ length: 101 }, (_, index) => ({
          id: `event-${index}`,
          name: "shopify/order.paid",
          data: {},
        }))
      )
    ).toBe("invalid_event_batch");
  });

  it("uses bounded exponential backoff", () => {
    expect(webhookInboxRetryDelaySeconds(1, 60, 3600)).toBe(60);
    expect(webhookInboxRetryDelaySeconds(2, 60, 3600)).toBe(120);
    expect(webhookInboxRetryDelaySeconds(8, 60, 3600)).toBe(3600);
  });

  it("classifies permanent HTTP failures without persisting raw messages", () => {
    const permanent = classifyWebhookInboxDeliveryFailure({
      name: "DeliveryError",
      status: 401,
      message: "secret-token-value",
    });
    const retryable = classifyWebhookInboxDeliveryFailure({
      name: "DeliveryError",
      response: { status: 429 },
      message: "customer payload",
    });

    expect(permanent).toEqual({ errorCode: "DeliveryError:http_401", terminal: true });
    expect(retryable).toEqual({ errorCode: "DeliveryError:http_429", terminal: false });
    expect(JSON.stringify([permanent, retryable])).not.toContain("secret-token-value");
    expect(JSON.stringify([permanent, retryable])).not.toContain("customer payload");
  });
});
