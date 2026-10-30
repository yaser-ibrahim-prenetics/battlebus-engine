import { describe, expect, it, vi } from "vitest";

import {
  readTripleWhaleAttributionSummary,
  readTripleWhaleMappedPairPage,
  readTripleWhaleMappedPairSnapshot,
} from "@/lib/clients/triple-whale";

const snapshotHash = "a".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function summaryInput() {
  return {
    apiKey: "secret",
    shopId: "im8store.myshopify.com",
    reportingDate: "2026-10-28",
    pageSize: 500,
    maxRows: 100,
  };
}

describe("Triple Whale channel-lift client", () => {
  it("builds a payload-free bounded channel summary", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: "3", orders: "2", pairs: "2" }]))
      .mockResolvedValueOnce(
        jsonResponse([
          { channel: "klaviyo", rows: "2", pairs: "1" },
          { channel: "other", rows: "1", pairs: "1" },
        ])
      )
      .mockResolvedValueOnce(jsonResponse([{ rows: "3", orders: "2", pairs: "2" }]));

    await expect(
      readTripleWhaleAttributionSummary(summaryInput(), { fetch, sleep: vi.fn() })
    ).resolves.toMatchObject({
      counts: { rows: 3, orders: 2, pairs: 2 },
      channels: [
        { channel: "klaviyo", rows: 2, pairs: 1 },
        { channel: "other", rows: 1, pairs: 1 },
      ],
    });
    const request = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(request.query).toContain("GROUP BY channel");
    expect(request.query).not.toContain("order_id, channel, event_date");
  });

  it("rejects relationally impossible aggregate counts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: "1", orders: "1", pairs: "2" }]));
    await expect(
      readTripleWhaleAttributionSummary(summaryInput(), { fetch, sleep: vi.fn() })
    ).rejects.toThrow("triple_whale_aggregate_invalid");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects channel summaries that do not reconcile with aggregate counts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: 2, orders: 2, pairs: 2 }]))
      .mockResolvedValueOnce(jsonResponse([{ channel: "klaviyo", rows: 1, pairs: 1 }]));
    await expect(
      readTripleWhaleAttributionSummary(summaryInput(), { fetch, sleep: vi.fn() })
    ).rejects.toThrow("triple_whale_snapshot_changed");
  });

  it("retries rate limits with bounded backoff", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse([{ rows: 0, orders: 0, pairs: 0 }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ rows: 0, orders: 0, pairs: 0 }]));
    await expect(
      readTripleWhaleAttributionSummary(summaryInput(), { fetch, sleep })
    ).resolves.toMatchObject({ counts: { rows: 0, orders: 0, pairs: 0 }, channels: [] });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("rejects provider inventories beyond the configured row ceiling", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ rows: 101, orders: 101, pairs: 101 }]));
    await expect(
      readTripleWhaleAttributionSummary(summaryInput(), { fetch, sleep: vi.fn() })
    ).rejects.toThrow("triple_whale_row_limit_exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("binds mapped-pair inventory to a global provider snapshot", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse([{ pairs: "1", snapshot_hash: snapshotHash }]));
    await expect(
      readTripleWhaleMappedPairSnapshot(
        { ...summaryInput(), sourceChannels: ["klaviyo"] },
        { fetch, sleep: vi.fn() }
      )
    ).resolves.toEqual({ pairs: 1, snapshotHash });
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request.query).toContain("SHA256");
    expect(request.query).toContain("GROUP BY order_id, channel");
  });

  it("reconstructs one bounded pair page with the same global snapshot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      jsonResponse([
        {
          order_id: "123",
          channel: "klaviyo",
          event_date: "2026-10-28",
          pairs: "1",
          snapshot_hash: snapshotHash,
        },
      ])
    );
    await expect(
      readTripleWhaleMappedPairPage(
        {
          apiKey: "secret",
          shopId: "im8store.myshopify.com",
          reportingDate: "2026-10-28",
          sourceChannels: ["klaviyo"],
          offset: 500,
          limit: 500,
        },
        { fetch, sleep: vi.fn() }
      )
    ).resolves.toEqual({
      rows: [{ orderId: "123", channel: "klaviyo", eventDate: "2026-10-28" }],
      pairs: 1,
      snapshotHash,
    });
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request.query).toContain("CROSS JOIN snapshot");
    expect(request.query).toContain("LIMIT 500 OFFSET 500");
  });
});
