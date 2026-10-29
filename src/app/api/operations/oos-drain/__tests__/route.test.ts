import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { submitOosDrainRequest, createOosDrainPreviewRequest, executeOosDrain, logRecoveryFailure } =
  vi.hoisted(() => ({
    submitOosDrainRequest: vi.fn(),
    createOosDrainPreviewRequest: vi.fn(),
    executeOosDrain: vi.fn(),
    logRecoveryFailure: vi.fn(),
  }));

vi.mock("@/lib/services/oos-recovery/requests", () => ({
  submitOosDrainRequest,
  createOosDrainPreviewRequest,
}));
vi.mock("@/lib/services/oos-recovery/drain", () => ({ executeOosDrain }));
vi.mock("@/lib/services/operations/diagnostics", () => ({ logRecoveryFailure }));
vi.mock("@/lib/config", () => ({
  config: { oosRecovery: { enabled: true, claimBatchSize: 100 } },
}));

import { POST } from "../route";

const originalApiKey = process.env.BATTLE_BUS_API_KEY;
const requestId = "00000000-0000-4000-8000-000000000004";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/operations/oos-drain", {
    method: "POST",
    headers: {
      authorization: "Bearer operations-key",
      "content-type": "application/json",
      "x-actor-id": "operator-1",
      "x-actor-email": "operator@example.com",
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
  process.env.BATTLE_BUS_API_KEY = "operations-key";
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
  executeOosDrain.mockResolvedValue({ selectedOrders: 1, decisions: [] });
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.BATTLE_BUS_API_KEY;
  else process.env.BATTLE_BUS_API_KEY = originalApiKey;
});

describe("OOS drain operations route", () => {
  it("rejects missing operator identity and unknown body fields", async () => {
    const missingIdentity = await POST(request(validBody, { "x-actor-id": "" }));
    const unknownField = await POST(request({ ...validBody, requestedBy: "spoofed" }));

    expect(missingIdentity.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(submitOosDrainRequest).not.toHaveBeenCalled();
  });

  it("derives the audited actor from headers for a persisted live request", async () => {
    const response = await POST(request(validBody));

    expect(response.status).toBe(202);
    expect(submitOosDrainRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: requestId,
        requestedBy: "operator-1:operator@example.com",
        requestReason: validBody.reason,
      })
    );
    expect(executeOosDrain).not.toHaveBeenCalled();
  });

  it("executes dry runs through the non-persistent preview path", async () => {
    const response = await POST(request({ ...validBody, dryRun: true }));

    expect(response.status).toBe(200);
    expect(createOosDrainPreviewRequest).toHaveBeenCalledOnce();
    expect(executeOosDrain).toHaveBeenCalledOnce();
    expect(submitOosDrainRequest).not.toHaveBeenCalled();
  });

  it("does not expose internal exception messages", async () => {
    submitOosDrainRequest.mockRejectedValue(new Error("postgres://secret@internal/database"));
    const response = await POST(request(validBody));

    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(logRecoveryFailure).toHaveBeenCalledOnce();
  });
});
