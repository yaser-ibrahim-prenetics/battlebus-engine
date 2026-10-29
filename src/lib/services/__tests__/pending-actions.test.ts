import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));

import {
  claimPendingActions,
  completePendingAction,
  importLegacyPendingActions,
  retryPendingAction,
  storePendingAction,
  type ClaimedPendingAction,
} from "../pending-actions";
import { config } from "@/lib/config";
import { completePendingActionSQL, retryPendingActionSQL } from "@/lib/sql/pending-actions/finish";

const mutablePendingConfig = config.pendingActions as unknown as {
  durableQueueEnabled: boolean;
  legacyProjectionEnabled: boolean;
};

const claim: ClaimedPendingAction = {
  actionId: "11111111-1111-4111-8111-111111111111",
  orderId: "1001",
  action: "cancel",
  eventName: "shopify/order.cancelled",
  eventData: { shopifyOrderId: "1001" },
  leaseToken: "22222222-2222-4222-8222-222222222222",
  attempts: 1,
};

describe("durable pending actions", () => {
  const originalQueueEnabled = mutablePendingConfig.durableQueueEnabled;
  const originalProjectionEnabled = mutablePendingConfig.legacyProjectionEnabled;

  beforeEach(() => {
    query.mockReset();
    mutablePendingConfig.durableQueueEnabled = true;
    mutablePendingConfig.legacyProjectionEnabled = true;
  });

  afterEach(() => {
    mutablePendingConfig.durableQueueEnabled = originalQueueEnabled;
    mutablePendingConfig.legacyProjectionEnabled = originalProjectionEnabled;
  });

  it("returns the stable database action ID for duplicate-safe enqueue", async () => {
    query.mockResolvedValueOnce({ rows: [{ action_id: claim.actionId }], rowCount: 1 });

    await expect(
      storePendingAction("1001", {
        action: "cancel",
        eventName: claim.eventName,
        eventData: claim.eventData,
        sourceEventId: "shopify-order-cancelled-1001",
      })
    ).resolves.toBe(claim.actionId);

    expect(query.mock.calls[0][1]?.slice(0, 5)).toEqual([
      "1001",
      "cancel",
      "shopify-order-cancelled-1001",
      claim.eventName,
      JSON.stringify(claim.eventData),
    ]);
    expect(JSON.parse(String(query.mock.calls[0][1]?.[5]))).toMatchObject({
      action: "cancel",
      eventName: claim.eventName,
      eventData: claim.eventData,
      sourceEventId: "shopify-order-cancelled-1001",
    });
    expect(query.mock.calls[0][1]?.[6]).toBe(true);
  });

  it("writes only the rollback-compatible legacy projection before activation", async () => {
    mutablePendingConfig.durableQueueEnabled = false;
    query.mockResolvedValueOnce({ rows: [{ id: "order-row" }], rowCount: 1 });

    await expect(
      storePendingAction("1001", {
        action: "cancel",
        eventName: claim.eventName,
        eventData: claim.eventData,
        sourceEventId: "shopify-order-cancelled-1001",
      })
    ).resolves.toBe("legacy:shopify-order-cancelled-1001");
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("UPDATE public.orders");
  });

  it("rejects an action without a stable producer event ID", async () => {
    await expect(
      storePendingAction("1001", {
        action: "fulfill",
        eventName: "shopify/order.fulfilled",
        eventData: {},
        sourceEventId: "",
      })
    ).rejects.toThrow("Invalid pending action source event ID");
    expect(query).not.toHaveBeenCalled();
  });

  it("maps claimed rows without exposing database naming to callers", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          action_id: claim.actionId,
          order_id: claim.orderId,
          action_type: claim.action,
          event_name: claim.eventName,
          event_data: claim.eventData,
          lease_token: claim.leaseToken,
          attempts: claim.attempts,
        },
      ],
    });
    await expect(claimPendingActions()).resolves.toEqual([claim]);
  });

  it("acknowledges exactly the action and lease that were claimed", async () => {
    query.mockResolvedValueOnce({ rows: [{ action_id: claim.actionId }], rowCount: 1 });
    await completePendingAction(claim);
    expect(query).toHaveBeenCalledWith(completePendingActionSQL, [
      claim.actionId,
      claim.leaseToken,
    ]);
  });

  it("fails closed when acknowledgement no longer owns the lease", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(completePendingAction(claim)).rejects.toThrow("lease lost");
  });

  it("retries by stable action and lease without persisting provider errors", async () => {
    query.mockResolvedValueOnce({ rows: [{ action_id: claim.actionId }], rowCount: 1 });
    await retryPendingAction(claim);
    expect(query.mock.calls[0][0]).toBe(retryPendingActionSQL);
    expect(query.mock.calls[0][1]?.slice(0, 2)).toEqual([claim.actionId, claim.leaseToken]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("provider");
  });

  it("imports and clears valid legacy arrays in one database operation", async () => {
    query.mockResolvedValueOnce({ rows: [{ imported: "3", source_orders: "2" }] });
    await expect(importLegacyPendingActions()).resolves.toEqual({ imported: 3, sourceOrders: 2 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
