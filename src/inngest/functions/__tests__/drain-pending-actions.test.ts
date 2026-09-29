import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimPendingActions,
  completePendingActions,
  loadClaimedPendingActions,
  type ClaimedPendingAction,
} from "@/lib/services/pending-actions";
import { runDrainPendingActions } from "../drain-pending-actions";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@/lib/services/pending-actions", () => ({
  claimPendingActions: vi.fn(),
  completePendingActions: vi.fn(),
  loadClaimedPendingActions: vi.fn(),
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
    blockedByCancellation: false,
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
    vi.mocked(claimPendingActions).mockResolvedValue(0);
    const step = { run: vi.fn(async (_name: string, callback: () => unknown) => callback()) };

    const result = await runDrainPendingActions({
      step,
      event: { id: "test-run", data: {} },
    });

    expect(result).toEqual({ status: "idle", processed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(loadClaimedPendingActions).not.toHaveBeenCalled();
    expect(completePendingActions).not.toHaveBeenCalled();
  });

  it("publishes stable event ids and supersedes fulfillment when cancellation is pending", async () => {
    vi.mocked(claimPendingActions).mockResolvedValue(3);
    vi.mocked(loadClaimedPendingActions).mockResolvedValue([
      claimed({
        id: "00000000-0000-0000-0000-000000000001",
        action: "cancel",
        eventName: "shopify/order.cancelled",
      }),
      claimed({
        id: "00000000-0000-0000-0000-000000000002",
        blockedByCancellation: true,
      }),
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

  it("supersedes fulfillment when cancellation exists outside the claimed batch", async () => {
    vi.mocked(claimPendingActions).mockResolvedValue(1);
    vi.mocked(loadClaimedPendingActions).mockResolvedValue([
      claimed({ blockedByCancellation: true }),
    ]);
    vi.mocked(completePendingActions).mockResolvedValue(1);
    const stepOutputs: unknown[] = [];
    const step = {
      run: vi.fn(async (_name: string, callback: () => unknown) => {
        const output = await callback();
        stepOutputs.push(output);
        return output;
      }),
    };

    const result = await runDrainPendingActions({
      step,
      event: { id: "test-run", data: {} },
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(completePendingActions).toHaveBeenCalledWith({
      claimToken: expect.any(String),
      publishedIds: [],
      supersededIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(JSON.stringify(stepOutputs)).not.toContain("eventData");
    expect(result).toEqual({
      status: "drained",
      processed: 1,
      eventsEmitted: 0,
      superseded: 1,
    });
  });
});
