import { beforeEach, describe, expect, it, vi } from "vitest";

import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import {
  acceptRefundRecovery,
  beginRefundLineCreation,
  claimRefundRecoveries,
  completeRefundOperation,
  deferRefundUntilOrder,
  loadRefundRecoveryDispatches,
  markRefundLineCreated,
  reserveRefundOperation,
} from "../refund-operations";

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  queryDatabase: vi.fn(),
}));

describe("refund operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  });

  it("atomically reserves one database-owned refund operation", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          claimed: true,
          state: "processing",
          claim_token: "00000000-0000-0000-0000-000000000099",
        },
      ],
    });

    const result = await reserveRefundOperation({
      refundId: "refund-42",
      shopifyOrderId: "1001",
      eventName: "shopify/refund.created",
      eventData: { refundId: "refund-42" },
      claimToken: "00000000-0000-0000-0000-000000000099",
      leaseSeconds: 10,
    });

    expect(result).toEqual({
      claimed: true,
      state: "processing",
      claimToken: "00000000-0000-0000-0000-000000000099",
      d365OrderNumber: null,
      inventoryLotId: null,
      externalIdempotencyKey: null,
    });
    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (refund_id) DO UPDATE"),
      [
        "refund-42",
        "1001",
        "shopify/refund.created",
        JSON.stringify({ refundId: "refund-42" }),
        "00000000-0000-0000-0000-000000000099",
        60,
      ]
    );
  });

  it("reports an existing completed refund without acquiring it", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ claimed: false, state: "completed", claim_token: null }],
    });

    const result = await reserveRefundOperation({
      refundId: "refund-42",
      shopifyOrderId: "1001",
      eventName: "shopify/refund.created",
      eventData: { refundId: "refund-42" },
      claimToken: "00000000-0000-0000-0000-000000000099",
    });

    expect(result).toEqual({
      claimed: false,
      state: "completed",
      claimToken: null,
      d365OrderNumber: null,
      inventoryLotId: null,
      externalIdempotencyKey: null,
    });
  });

  it("fails closed when PostgreSQL is unavailable", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    await expect(
      reserveRefundOperation({
        refundId: "refund-42",
        shopifyOrderId: "1001",
        eventName: "shopify/refund.created",
        eventData: { refundId: "refund-42" },
        claimToken: "00000000-0000-0000-0000-000000000099",
      })
    ).rejects.toThrow("Cloud SQL is required");
    expect(queryDatabase).not.toHaveBeenCalled();
  });

  it("accepts a recovery lease only through an atomic dispatch transition", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          claimed: true,
          state: "processing",
          claim_token: "00000000-0000-0000-0000-000000000099",
        },
      ],
    });

    const result = await acceptRefundRecovery({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000099",
    });

    expect(result.claimed).toBe(true);
    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("AND state = 'dispatching'"),
      ["refund-42", "00000000-0000-0000-0000-000000000099", 900]
    );
    expect(vi.mocked(queryDatabase).mock.calls[0]?.[0]).not.toContain(
      "state IN ('dispatching', 'processing')"
    );
  });

  it("defers an owned refund with bounded exponential backoff", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ refund_id: "refund-42" }],
    });

    await deferRefundUntilOrder({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000099",
      eventName: "shopify/refund.created",
      eventData: { refundId: "refund-42" },
      error: "D365 order is not visible yet",
    });

    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("LEAST(3600, 60 * power(2"),
      [
        "refund-42",
        "00000000-0000-0000-0000-000000000099",
        "shopify/refund.created",
        JSON.stringify({ refundId: "refund-42" }),
        "D365 order is not visible yet",
      ]
    );
  });

  it("claims due and expired recovery dispatches with bounded inputs", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ claimed_count: 2, dead_lettered_count: 1 }],
    });

    const count = await claimRefundRecoveries({
      claimToken: "00000000-0000-0000-0000-000000000099",
      batchSize: 1000,
      leaseSeconds: 5,
    });

    expect(count).toEqual({ claimedCount: 2, deadLetteredCount: 1 });
    expect(queryDatabase).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      100,
      "00000000-0000-0000-0000-000000000099",
      60,
      12,
    ]);
    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("state = 'dead_letter'"),
      expect.any(Array)
    );
  });

  it("loads recovery payloads only after a leased dispatch claim", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          refund_id: "refund-42",
          shopify_order_id: "1001",
          event_name: "shopify/refund.created",
          event_data: { refundId: "refund-42" },
          attempts: 3,
        },
      ],
    });

    const result = await loadRefundRecoveryDispatches({
      claimToken: "00000000-0000-0000-0000-000000000099",
    });

    expect(result).toEqual([
      {
        refundId: "refund-42",
        shopifyOrderId: "1001",
        eventName: "shopify/refund.created",
        eventData: { refundId: "refund-42" },
        attempts: 3,
      },
    ]);
  });

  it("records the D365 line while retaining exclusive ownership", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ refund_id: "refund-42" }],
    });

    await markRefundLineCreated({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000099",
      d365OrderNumber: "SO-42",
      inventoryLotId: "LOT-42",
    });

    expect(queryDatabase).toHaveBeenCalledWith(expect.stringContaining("state = 'line_created'"), [
      "refund-42",
      "00000000-0000-0000-0000-000000000099",
      "SO-42",
      "LOT-42",
    ]);
    expect(vi.mocked(queryDatabase).mock.calls[0]?.[0]).toContain("AND state = 'creating_line'");
  });

  it("checkpoints line creation with a stable external idempotency key", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          claimed: true,
          state: "creating_line",
          claim_token: "00000000-0000-0000-0000-000000000099",
          external_idempotency_key: "SHOPIFY-REFUND-abc",
        },
      ],
    });

    const result = await beginRefundLineCreation({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000099",
      externalIdempotencyKey: "SHOPIFY-REFUND-abc",
    });

    expect(result).toMatchObject({
      claimed: true,
      state: "creating_line",
      externalIdempotencyKey: "SHOPIFY-REFUND-abc",
    });
    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'creating_line'"),
      ["refund-42", "00000000-0000-0000-0000-000000000099", "SHOPIFY-REFUND-abc", 900]
    );
  });

  it("completes the owned operation and scrubs its recovery payload", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ refund_id: "refund-42" }],
    });

    await completeRefundOperation({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000099",
      d365OrderNumber: "SO-42",
      inventoryLotId: "LOT-42",
    });

    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("event_data = '{}'::jsonb"),
      ["refund-42", "00000000-0000-0000-0000-000000000099", "SO-42", "LOT-42"]
    );
  });
});
