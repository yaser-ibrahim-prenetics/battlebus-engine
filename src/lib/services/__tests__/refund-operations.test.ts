import { beforeEach, describe, expect, it, vi } from "vitest";

import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import {
  claimRefundRecoveries,
  deferRefundUntilOrder,
  loadRefundRecoveryDispatches,
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

    expect(result).toEqual({ claimed: false, state: "completed", claimToken: null });
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
      command: "UPDATE",
      rowCount: 2,
      oid: 0,
      fields: [],
      rows: [{ refund_id: "refund-1" }, { refund_id: "refund-2" }],
    });

    const count = await claimRefundRecoveries({
      claimToken: "00000000-0000-0000-0000-000000000099",
      batchSize: 1000,
      leaseSeconds: 5,
    });

    expect(count).toBe(2);
    expect(queryDatabase).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      100,
      "00000000-0000-0000-0000-000000000099",
      60,
    ]);
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
});
