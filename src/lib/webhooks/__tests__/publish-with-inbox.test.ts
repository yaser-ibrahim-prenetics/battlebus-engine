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
  delay: vi.fn(),
}));

vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/config", () => ({
  config: {
    webhookInbox: {
      leaseSeconds: 120,
      maxAttempts: 3,
      retryBaseSeconds: 60,
      retryMaxSeconds: 3600,
    },
  },
}));
vi.mock("@/lib/db/database", () => ({ isDatabaseConfigured: mocks.configured }));
vi.mock("@/lib/services/webhook-inbox", () => ({
  claimWebhookInboxEntry: mocks.claim,
  classifyWebhookInboxDeliveryFailure: mocks.classify,
  recordInboxEntry: mocks.record,
  markInboxPublished: mocks.published,
  markInboxFailed: mocks.failed,
  validateWebhookInboxEvents: mocks.validate,
  webhookInboxRetryDelaySeconds: mocks.delay,
}));

import { publishWebhookEvents } from "../publish-with-inbox";

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
    mocks.validate.mockReturnValue(null);
    mocks.record.mockResolvedValue(claimed.id);
    mocks.claim.mockResolvedValue(claimed);
    mocks.send.mockResolvedValue({ ids: [event.id] });
    mocks.published.mockResolvedValue(true);
    mocks.failed.mockResolvedValue("retryable");
    mocks.classify.mockReturnValue({ errorCode: "DeliveryError:http_503", terminal: false });
    mocks.delay.mockReturnValue(60);
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
