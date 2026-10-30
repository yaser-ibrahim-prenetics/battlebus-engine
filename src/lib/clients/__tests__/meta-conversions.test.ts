import { describe, expect, it, vi } from "vitest";

import { sendMetaChannelLiftBatch } from "@/lib/clients/meta-conversions";
import type { MetaChannelLiftEvent } from "@/lib/channel-lift/model";

const event: MetaChannelLiftEvent = {
  event_name: "Purchase_Klaviyo",
  event_id: "event-id",
  event_time: 1_798_000_000,
  action_source: "website",
  event_source_url: "https://im8health.com/",
  user_data: { em: ["hash"] },
  custom_data: { value: 12.3, currency: "USD" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Meta channel-lift client", () => {
  it("requires exact batch acceptance", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ events_received: 0 }));
    await expect(
      sendMetaChannelLiftBatch(
        { datasetId: "123", accessToken: "secret", events: [event] },
        { fetch, sleep: vi.fn() }
      )
    ).rejects.toThrow("meta_receipt_mismatch");
  });

  it("retries 429 responses and never puts the token in the URL", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ events_received: 1 }));
    await expect(
      sendMetaChannelLiftBatch(
        { datasetId: "123", accessToken: "secret", events: [event] },
        { fetch, sleep }
      )
    ).resolves.toEqual({ eventsReceived: 1 });
    expect(fetch.mock.calls[0][0]).toBe("https://graph.facebook.com/v26.0/123/events");
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
