import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimRefundRecoveries,
  loadRefundRecoveryDispatches,
} from "@/lib/services/refund-operations";
import { runRecoverPendingRefunds } from "../recover-pending-refunds";

const { logFlowEventMock, sendMock } = vi.hoisted(() => ({
  logFlowEventMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@/lib/services/refund-operations", () => ({
  claimRefundRecoveries: vi.fn(),
  loadRefundRecoveryDispatches: vi.fn(),
}));

vi.mock("@/lib/services/flow-logs", () => ({
  logFlowEvent: logFlowEventMock,
}));

vi.mock("../../client", () => ({
  inngest: {
    send: sendMock,
    createFunction: vi.fn((_options, handler) => handler),
  },
}));

describe("runRecoverPendingRefunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue(undefined);
  });

  it("returns idle without loading payloads when nothing is due", async () => {
    vi.mocked(claimRefundRecoveries).mockResolvedValue({
      claimedCount: 0,
      deadLetteredCount: 0,
    });
    const step = { run: vi.fn(async (_name: string, callback: () => unknown) => callback()) };

    const result = await runRecoverPendingRefunds({
      step,
      event: { id: "recovery-run" },
    });

    expect(result).toEqual({ status: "idle", dispatched: 0, deadLettered: 0 });
    expect(loadRefundRecoveryDispatches).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dispatches leased refunds with stable database-attempt event IDs", async () => {
    vi.mocked(claimRefundRecoveries).mockResolvedValue({
      claimedCount: 1,
      deadLetteredCount: 0,
    });
    vi.mocked(loadRefundRecoveryDispatches).mockResolvedValue([
      {
        refundId: "refund-42",
        shopifyOrderId: "1001",
        eventName: "shopify/refund.created",
        eventData: {
          shopifyOrderId: "1001",
          refundId: "refund-42",
          refundJson: { id: "refund-42" },
        },
        attempts: 3,
      },
    ]);
    const stepOutputs: unknown[] = [];
    const step = {
      run: vi.fn(async (_name: string, callback: () => unknown) => {
        const output = await callback();
        stepOutputs.push(output);
        return output;
      }),
    };

    const result = await runRecoverPendingRefunds({
      step,
      event: { id: "recovery-run" },
    });

    expect(sendMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "refund-recovery-refund-42-3",
        name: "shopify/refund.created",
        data: expect.objectContaining({
          refundId: "refund-42",
          refundRecoveryToken: expect.any(String),
          refundRecoveryAttempt: 3,
        }),
      }),
    ]);
    expect(JSON.stringify(stepOutputs)).not.toContain("refundJson");
    expect(result).toEqual({
      status: "dispatched",
      dispatched: 1,
      refundIds: ["refund-42"],
    });
  });

  it("reports terminal dead letters without loading scrubbed payloads", async () => {
    vi.mocked(claimRefundRecoveries).mockResolvedValue({
      claimedCount: 0,
      deadLetteredCount: 2,
    });
    const step = { run: vi.fn(async (_name: string, callback: () => unknown) => callback()) };

    const result = await runRecoverPendingRefunds({
      step,
      event: { id: "recovery-run" },
    });

    expect(result).toEqual({ status: "idle", dispatched: 0, deadLettered: 2 });
    expect(loadRefundRecoveryDispatches).not.toHaveBeenCalled();
    expect(logFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "refund_recovery",
        step: "dead_letter",
        status: "failed",
        payload: { deadLettered: 2 },
      })
    );
  });
});
