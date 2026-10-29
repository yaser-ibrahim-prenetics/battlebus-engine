import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  configured: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(),
  published: vi.fn(),
  failed: vi.fn(),
  validate: vi.fn(),
  classify: vi.fn(),
  maxAttempts: vi.fn(),
  policy: vi.fn(),
  webhookConfig: {
    durableDeliveryEnabled: true,
    leaseSeconds: 120,
    maxAttempts: 3,
    retryBaseSeconds: 60,
    retryMaxSeconds: 3600,
  },
}));

vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/config", () => ({
  config: { webhookInbox: mocks.webhookConfig },
}));
vi.mock("@/lib/db/database", () => ({ isDatabaseConfigured: mocks.configured }));
vi.mock("@/lib/services/webhook-inbox", () => ({
  claimWebhookInboxEntry: mocks.claim,
  classifyWebhookInboxDeliveryFailure: mocks.classify,
  webhookInboxDeliveryMaxAttempts: mocks.maxAttempts,
  webhookInboxDeliveryPolicy: mocks.policy,
  recordInboxEntry: mocks.record,
  markInboxPublished: mocks.published,
  markInboxFailed: mocks.failed,
  validateWebhookInboxEvents: mocks.validate,
}));

import { publishWebhookEvents, redactWebhookHeaders } from "../publish-with-inbox";

const event = {
  id: "shopify-order-1",
  name: "shopify/order.paid",
  data: { orderId: "1" },
};
const claimed = {
  id: "0f7f31aa-f686-4d8d-b565-1f657fe6aa57",
  source: "shopify",
  topic: "orders/paid",
  events: [event],
  attempts: 1,
  replayCount: 0,
  leaseToken: "00000000-0000-4000-8000-000000000000",
  leaseExpiresAt: "2026-10-29T00:00:00.000Z",
};

describe("publishWebhookEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configured.mockReturnValue(true);
    mocks.webhookConfig.durableDeliveryEnabled = true;
    mocks.validate.mockReturnValue(null);
    mocks.record.mockResolvedValue(claimed.id);
    mocks.claim.mockResolvedValue(claimed);
    mocks.send.mockResolvedValue({ ids: [event.id] });
    mocks.published.mockResolvedValue(true);
    mocks.failed.mockResolvedValue("retryable");
    mocks.classify.mockReturnValue({ errorCode: "DeliveryError:http_503", terminal: false });
    mocks.maxAttempts.mockImplementation((enabled: boolean, configured: number) =>
      enabled ? configured : 2_000_000_000
    );
    mocks.policy.mockImplementation(
      (params: { durableDeliveryEnabled: boolean; configuredMaxAttempts: number }) => ({
        maxAttempts: params.durableDeliveryEnabled ? params.configuredMaxAttempts : 2_000_000_000,
        retryDelaySeconds: params.durableDeliveryEnabled ? 60 : 1,
        terminal: false,
      })
    );
  });

  async function publish() {
    return publishWebhookEvents({
      source: "shopify",
      topic: "orders/paid",
      payload: { id: "1" },
      headers: { "x-shopify-hmac-sha256": "secret" },
      events: [event],
    });
  }

  it("fails closed when configured durable storage cannot record the receipt", async () => {
    mocks.record.mockResolvedValue(null);

    await expect(publish()).resolves.toEqual({
      published: false,
      inboxId: null,
      error: "durable_receipt_unavailable",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("claims and acknowledges the exact durable receipt", async () => {
    await expect(publish()).resolves.toEqual({
      published: true,
      eventIds: [event.id],
      inboxId: claimed.id,
    });
    expect(mocks.claim).toHaveBeenCalledWith(claimed.id, {
      leaseSeconds: 120,
      maxAttempts: 3,
    });
    expect(mocks.published).toHaveBeenCalledWith(claimed, [event.id]);
  });

  it("preserves compatible publication while leased delivery is disabled", async () => {
    mocks.webhookConfig.durableDeliveryEnabled = false;

    await expect(publish()).resolves.toEqual({
      published: true,
      eventIds: [event.id],
      inboxId: claimed.id,
    });
    expect(mocks.claim).toHaveBeenCalledWith(claimed.id, {
      leaseSeconds: 120,
      maxAttempts: 2_000_000_000,
    });
    expect(mocks.published).toHaveBeenCalledWith(claimed, [event.id]);
  });

  it("keeps compatibility failures immediately retryable without terminal classification", async () => {
    mocks.webhookConfig.durableDeliveryEnabled = false;
    mocks.send.mockRejectedValue({ name: "DeliveryError", status: 401 });
    mocks.classify.mockReturnValue({ errorCode: "DeliveryError:http_401", terminal: true });

    await expect(publish()).resolves.toMatchObject({ published: false });
    expect(mocks.failed).toHaveBeenCalledWith(claimed, {
      errorCode: "DeliveryError:http_401",
      maxAttempts: 2_000_000_000,
      retryDelaySeconds: 1,
      terminal: false,
    });
  });

  it("persists only bounded allowlisted transport metadata", () => {
    expect(
      redactWebhookHeaders({
        "Content-Type": "application/json",
        "X-Shopify-Webhook-Id": "webhook-1",
        "X-Shopify-Hmac-Sha256": "secret-signature",
        Authorization: "Bearer secret",
        "X-Untrusted-Metadata": "customer-data",
      })
    ).toEqual({
      "content-type": "application/json",
      "x-shopify-webhook-id": "webhook-1",
    });
  });

  it("records safe retry metadata when publication fails", async () => {
    mocks.send.mockRejectedValue(new Error("raw secret or payload"));

    await expect(publish()).resolves.toEqual({
      published: false,
      inboxId: claimed.id,
      error: "DeliveryError:http_503",
    });
    expect(mocks.failed).toHaveBeenCalledWith(claimed, {
      errorCode: "DeliveryError:http_503",
      maxAttempts: 3,
      retryDelaySeconds: 60,
      terminal: false,
    });
  });

  it("reports an uncertain send when the exact acknowledgement is lost", async () => {
    mocks.published.mockResolvedValue(false);

    await expect(publish()).resolves.toEqual({
      published: false,
      inboxId: claimed.id,
      error: "publication_acknowledgement_failed",
    });
  });
});
