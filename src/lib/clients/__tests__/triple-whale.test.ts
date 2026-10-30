import { describe, expect, it, vi } from "vitest";

import { readTripleWhaleAttribution } from "@/lib/clients/triple-whale";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Triple Whale channel-lift client", () => {
  it("fetches bounded pages and reconciles the aggregate inventory", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: "3", orders: "2", pairs: "2" }]))
      .mockResolvedValueOnce(
        jsonResponse([
          { order_id: "1", channel: "klaviyo", event_date: "2026-10-28" },
          { order_id: "1", channel: "klaviyo", event_date: "2026-10-28" },
        ])
      )
      .mockResolvedValueOnce(
        jsonResponse([{ order_id: "2", channel: "klaviyo", event_date: "2026-10-28" }])
      );

    const result = await readTripleWhaleAttribution(
      {
        apiKey: "secret",
        shopId: "im8store.myshopify.com",
        reportingDate: "2026-10-28",
        pageSize: 2,
      },
      { fetch, sleep: vi.fn() }
    );

    expect(result.counts).toEqual({ rows: 3, orders: 2, pairs: 2 });
    expect(result.rows).toHaveLength(3);
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch).toHaveBeenCalledTimes(3);
    const finalRequest = JSON.parse(String(fetch.mock.calls[2][1]?.body));
    expect(finalRequest.query).toContain("OFFSET 2");
  });

  it("fails closed when aggregate and fetched counts disagree", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: 2, orders: 2, pairs: 2 }]))
      .mockResolvedValueOnce(
        jsonResponse([{ order_id: "1", channel: "klaviyo", event_date: "2026-10-28" }])
      );
    await expect(
      readTripleWhaleAttribution(
        {
          apiKey: "secret",
          shopId: "im8store.myshopify.com",
          reportingDate: "2026-10-28",
          pageSize: 10,
        },
        { fetch, sleep: vi.fn() }
      )
    ).rejects.toThrow("extraction_count_mismatch");
  });

  it("retries rate limits with bounded backoff", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse([{ rows: 0, orders: 0, pairs: 0 }]));
    await expect(
      readTripleWhaleAttribution(
        {
          apiKey: "secret",
          shopId: "im8store.myshopify.com",
          reportingDate: "2026-10-28",
          pageSize: 100,
        },
        { fetch, sleep }
      )
    ).resolves.toMatchObject({ rows: [], counts: { rows: 0, orders: 0, pairs: 0 } });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
