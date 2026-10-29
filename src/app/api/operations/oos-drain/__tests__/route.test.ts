import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  submitOosDrainRequest,
  createOosDrainPreviewRequest,
  reserveOosDrainPreviewCommand,
  finishOosDrainPreviewCommand,
  executeOosDrain,
  logRecoveryFailure,
  OosDrainCommandConflictError,
  OosDrainCommandInProgressError,
} = vi.hoisted(() => {
  class ConflictError extends Error {}
  class InProgressError extends Error {}
  return {
    submitOosDrainRequest: vi.fn(),
    createOosDrainPreviewRequest: vi.fn(),
    reserveOosDrainPreviewCommand: vi.fn(),
    finishOosDrainPreviewCommand: vi.fn(),
    executeOosDrain: vi.fn(),
    logRecoveryFailure: vi.fn(),
    OosDrainCommandConflictError: ConflictError,
    OosDrainCommandInProgressError: InProgressError,
  };
});

vi.mock("@/lib/services/oos-recovery/requests", () => ({
  submitOosDrainRequest,
  createOosDrainPreviewRequest,
  reserveOosDrainPreviewCommand,
  finishOosDrainPreviewCommand,
  OosDrainCommandConflictError,
  OosDrainCommandInProgressError,
}));
vi.mock("@/lib/services/oos-recovery/drain", () => ({ executeOosDrain }));
vi.mock("@/lib/services/operations/diagnostics", () => ({ logRecoveryFailure }));
vi.mock("@/lib/config", () => ({
  config: { oosRecovery: { enabled: true, claimBatchSize: 100 } },
}));

import { POST } from "../route";

const originalApiKey = process.env.BATTLE_BUS_OPERATIONS_API_KEY;
const requestId = "00000000-0000-4000-8000-000000000004";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/operations/oos-drain", {
    method: "POST",
    headers: {
      authorization: "Bearer operations-key",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  requestId,
  reason: "Inventory provider has been checked by the operator",
  mode: "manual",
  dryRun: false,
  provider: "gps",
  warehouse: "US",
  sku: "SKU-1",
};

beforeEach(() => {
  process.env.BATTLE_BUS_OPERATIONS_API_KEY = "operations-key";
  vi.clearAllMocks();
  submitOosDrainRequest.mockResolvedValue({
    created: true,
    request: { id: "drain-1", laneKey: "live:inventory:gps:US:SKU-1", dryRun: false },
  });
  const preview = {
    id: "preview-1",
    laneKey: "dry:inventory:gps:US:SKU-1",
    dryRun: true,
  };
  createOosDrainPreviewRequest.mockReturnValue(preview);
  reserveOosDrainPreviewCommand.mockResolvedValue({
    status: "execute",
    executionToken: "00000000-0000-4000-8000-000000000005",
  });
  finishOosDrainPreviewCommand.mockResolvedValue(true);
  executeOosDrain.mockResolvedValue({
    examinedOrders: 1,
    selectedOrders: 1,
    selectedDependencies: 1,
    manualReviewExpired: 0,
    queuedKeys: 0,
    decisions: [],
  });
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.BATTLE_BUS_OPERATIONS_API_KEY;
  else process.env.BATTLE_BUS_OPERATIONS_API_KEY = originalApiKey;
});

describe("OOS drain operations route", () => {
  it("rejects the general service key, internal modes and unknown body fields", async () => {
    const generalKey = await POST(
      request(validBody, { authorization: "Bearer general-service-key" })
    );
    const internalMode = await POST(request({ ...validBody, mode: "sweep" }));
    const unknownField = await POST(request({ ...validBody, requestedBy: "spoofed" }));

    expect(generalKey.status).toBe(401);
    expect(internalMode.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(submitOosDrainRequest).not.toHaveBeenCalled();
  });

  it("derives a non-spoofable operations principal for a persisted live request", async () => {
    const response = await POST(request(validBody));

    expect(response.status).toBe(202);
    expect(submitOosDrainRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: "service:battle-bus-operations",
        requestReason: validBody.reason,
      }),
      {
        actor: "service:battle-bus-operations",
        reason: validBody.reason,
        requestId,
      }
    );
    expect(executeOosDrain).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ requestId, drainRequestId: "drain-1" })
    );
  });

  it("rejects incomplete, missing, and reversed targets as client errors", async () => {
    const incomplete = await POST(request({ ...validBody, sku: undefined }));
    const missing = await POST(
      request({
        requestId,
        reason: validBody.reason,
        mode: "manual",
        dryRun: false,
      })
    );
    const reversed = await POST(
      request({
        ...validBody,
        parkedFrom: "2026-10-30T00:00:00.000Z",
        parkedTo: "2026-10-29T00:00:00.000Z",
      })
    );

    expect([incomplete.status, missing.status, reversed.status]).toEqual([400, 400, 400]);
    expect(submitOosDrainRequest).not.toHaveBeenCalled();
  });

  it("executes dry runs through the non-persistent preview path", async () => {
    const response = await POST(request({ ...validBody, dryRun: true }));

    expect(response.status).toBe(200);
    expect(reserveOosDrainPreviewCommand).toHaveBeenCalledOnce();
    expect(createOosDrainPreviewRequest).toHaveBeenCalledOnce();
    expect(executeOosDrain).toHaveBeenCalledOnce();
    expect(finishOosDrainPreviewCommand).toHaveBeenCalledOnce();
    expect(finishOosDrainPreviewCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        executionToken: "00000000-0000-4000-8000-000000000005",
      })
    );
    expect(submitOosDrainRequest).not.toHaveBeenCalled();
  });

  it("does not expose internal exception messages", async () => {
    submitOosDrainRequest.mockRejectedValue(new Error("postgres://secret@internal/database"));
    const response = await POST(request(validBody));

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(logRecoveryFailure).toHaveBeenCalledOnce();
  });
});
