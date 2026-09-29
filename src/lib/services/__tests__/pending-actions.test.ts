import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryDatabase } from "@/lib/db/database";
import {
  buildPendingActionIdempotencyKey,
  claimPendingActions,
  storePendingAction,
} from "../pending-actions";

vi.mock("@/lib/db/database", () => ({
  queryDatabase: vi.fn(),
}));

describe("pending actions persistence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the same idempotency key for equivalent object key order", () => {
    const left = buildPendingActionIdempotencyKey("1001", {
      action: "fulfill",
      eventName: "shopify/order.fulfilled",
      eventData: { nested: { b: 2, a: 1 }, shopifyOrderId: "1001" },
    });
    const right = buildPendingActionIdempotencyKey("1001", {
      action: "fulfill",
      eventName: "shopify/order.fulfilled",
      eventData: { shopifyOrderId: "1001", nested: { a: 1, b: 2 } },
    });

    expect(left).toBe(right);
  });

  it("inserts with conflict-safe deduplication", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "INSERT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ id: "00000000-0000-0000-0000-000000000001" }],
    });

    await storePendingAction("1001", {
      action: "cancel",
      eventName: "shopify/order.cancelled",
      eventData: { shopifyOrderId: "1001", shopifyOrderName: "#IM8-1001" },
      createdAt: "2026-09-29T00:00:00.000Z",
    });

    expect(queryDatabase).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (idempotency_key) DO NOTHING"),
      expect.arrayContaining(["1001", "#IM8-1001", "cancel", "shopify/order.cancelled"])
    );
  });

  it("claims ready and expired actions with a bounded lease", async () => {
    vi.mocked(queryDatabase).mockResolvedValueOnce({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          shopify_order_id: "1001",
          shopify_order_name: "#IM8-1001",
          action: "cancel",
          event_name: "shopify/order.cancelled",
          event_data: { shopifyOrderId: "1001" },
          idempotency_key: "key",
          attempts: 2,
          created_at: "2026-09-29T00:00:00.000Z",
        },
      ],
    });

    const result = await claimPendingActions({
      claimToken: "00000000-0000-0000-0000-000000000099",
      batchSize: 1000,
      leaseSeconds: 5,
    });

    expect(queryDatabase).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      500,
      "00000000-0000-0000-0000-000000000099",
      30,
    ]);
    expect(result[0]).toMatchObject({
      shopifyOrderId: "1001",
      action: "cancel",
      attempts: 2,
    });
  });
});
