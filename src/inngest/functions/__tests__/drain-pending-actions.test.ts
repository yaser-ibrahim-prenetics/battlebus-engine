import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimPendingActions,
  completePendingActions,
  type ClaimedPendingAction,
} from "@/lib/services/pending-actions";
import { runDrainPendingActions } from "../drain-pending-actions";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@/lib/services/pending-actions", () => ({
  claimPendingActions: vi.fn(),
  completePendingActions: vi.fn(),
}));

vi.mock("@/lib/services/flow-logs", () => ({
  logFlowEvent: vi.fn(),
}));

vi.mock("../../client", () => ({
  inngest: {
    send: sendMock,
    createFunction: vi.fn((_options, handler) => handler),
  },
}));

function claimed(overrides: Partial<ClaimedPendingAction>): ClaimedPendingAction {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    shopifyOrderId: "1001",
    shopifyOrderName: "#IM8-1001",
    action: "fulfill",
    eventName: "shopify/order.fulfilled",
    eventData: { shopifyOrderId: "1001" },
    idempotencyKey: "key",
    attempts: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("runDrainPendingActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(completePendingActions).mockResolvedValue(0);
    sendMock.mockResolvedValue(undefined);
  });

  it("returns idle when no durable actions are ready", async () => {
    vi.mocked(claimPendingActions).mockResolvedValue([]);
    const step = { run: vi.fn(async (_name: string, callback: () => unknown) => callback()) };

    const result = await runDrainPendingActions({
      step,
      event: { id: "test-run", data: {} },
    });

    expect(result).toEqual({ status: "idle", processed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(completePendingActions).not.toHaveBeenCalled();
  });

  it("publishes stable event ids and supersedes fulfillment when cancellation is pending", async () => {
    vi.mocked(claimPendingActions).mockResolvedValue([
      claimed({
        id: "00000000-0000-0000-0000-000000000001",
        action: "cancel",
        eventName: "shopify/order.cancelled",
      }),
      claimed({ id: "00000000-0000-0000-0000-000000000002" }),
      claimed({
        id: "00000000-0000-0000-0000-000000000003",
        shopifyOrderId: "1002",
        shopifyOrderName: "#IM8-1002",
        eventData: { shopifyOrderId: "1002" },
      }),
    ]);
    vi.mocked(completePendingActions).mockResolvedValue(3);
    const step = { run: vi.fn(async (_name: string, callback: () => unknown) => callback()) };

    const result = await runDrainPendingActions({
      step,
      event: { id: "test-run", data: {} },
    });

    expect(sendMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "pending-action-00000000-0000-0000-0000-000000000001",
        name: "shopify/order.cancelled",
        data: expect.objectContaining({ fromDrain: true }),
      }),
      expect.objectContaining({
        id: "pending-action-00000000-0000-0000-0000-000000000003",
        name: "shopify/order.fulfilled",
        data: expect.objectContaining({ fromDrain: true }),
      }),
    ]);
    expect(completePendingActions).toHaveBeenCalledWith({
      claimToken: expect.any(String),
      publishedIds: [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000003",
      ],
      supersededIds: ["00000000-0000-0000-0000-000000000002"],
    });
    expect(result).toEqual({
      status: "drained",
      processed: 3,
      eventsEmitted: 2,
      superseded: 1,
    });
  });
});
