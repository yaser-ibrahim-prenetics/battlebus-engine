import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryDatabase } from "@/lib/db/database";
import { claimOutboxForInbox, recordInboxEntry, requeueDeadLetter } from "../webhook-inbox";

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  queryDatabase: vi.fn(),
  quoteIdentifier: vi.fn((value: string) => `"${value}"`),
}));

describe("durable webhook inbox and outbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atomically records a receipt and its idempotent outbox events", async () => {
    vi.mocked(queryDatabase).mockImplementationOnce(async (_sql, values) => ({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          status: "received",
          payload_hash: values?.[7],
          duplicate_count: 0,
        },
      ],
    }));

    const receipt = await recordInboxEntry({
      source: "shopify",
      topic: "orders/create",
      payload: { b: 2, a: 1 },
      headers: { "x-shopify-webhook-id": "webhook-1001" },
      schemaVersion: "1.0",
      events: [
        {
          name: "shopify/order.created",
          data: { order: { id: 1001, name: "#IM8-1001" } },
        },
      ],
    });

    const [sql, values] = vi.mocked(queryDatabase).mock.calls[0];
    expect(sql).toContain("ON CONFLICT (source, idempotency_key) DO UPDATE");
    expect(sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(sql).toContain('INSERT INTO "workflow_timeline_events"');
    expect(values?.[2]).toBe('{"a":1,"b":2}');
    expect(values?.[5]).toBe("webhook-1001");
    expect(JSON.parse(String(values?.[8]))[0]).toMatchObject({
      event_name: "shopify/order.created",
      shopify_order_id: "1001",
      shopify_order_name: "#IM8-1001",
    });
    expect(receipt).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      status: "received",
      duplicate: false,
    });
  });

  it("claims due events with a database lease", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          inbox_id: "00000000-0000-4000-8000-000000000001",
          source: "shopify",
          topic: "orders/create",
          schema_version: "1.0",
          event_name: "shopify/order.created",
          event_id: "event-1001",
          event_data: { shopifyOrderId: "1001" },
          idempotency_key: "shopify:event-1001",
          shopify_order_id: "1001",
          shopify_order_name: "#IM8-1001",
          attempts: 1,
          claim_token: "00000000-0000-4000-8000-000000000099",
        },
      ],
    });

    const entries = await claimOutboxForInbox("00000000-0000-4000-8000-000000000001", 20, 90);

    expect(queryDatabase).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      "00000000-0000-4000-8000-000000000001",
      20,
      90,
    ]);
    expect(vi.mocked(queryDatabase).mock.calls[0][0]).toContain(
      'INSERT INTO "workflow_timeline_events"'
    );
    expect(entries[0]).toMatchObject({ eventId: "event-1001", attempts: 1 });
  });

  it("only requeues rows that are already dead-lettered", async () => {
    vi.mocked(queryDatabase)
      .mockResolvedValueOnce({
        command: "UPDATE",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      })
      .mockResolvedValueOnce({
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [{ inbox_id: "00000000-0000-4000-8000-000000000001" }],
      })
      .mockResolvedValueOnce({
        command: "UPDATE",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [{ status: "received" }],
      });

    expect(await requeueDeadLetter("00000000-0000-4000-8000-000000000003")).toBe(false);
    expect(await requeueDeadLetter("00000000-0000-4000-8000-000000000004")).toBe(true);
    expect(vi.mocked(queryDatabase).mock.calls[1][0]).toContain("state = 'dead_letter'");
    expect(vi.mocked(queryDatabase).mock.calls[1][0]).not.toContain("attempts = 0");
  });
});
