import { beforeEach, expect, it, vi } from "vitest";
const { query, status, cancel } = vi.hoisted(() => ({
  query: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
vi.mock("@/lib/clients/operations/inngest", () => ({
  readWorkflowStatus: status,
  cancelWorkflow: cancel,
}));
import { cancelStuckWorkflow, closeStaleReconciliation } from "../stalled";
beforeEach(() => vi.resetAllMocks());
it("cannot cancel runs outside the stale local allowlist", async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(cancelStuckWorkflow("external-run")).rejects.toThrow("stale local run");
  expect(cancel).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
});
it("requires provider Running state and does not repeat terminal cancellations", async () => {
  query.mockResolvedValue({ rows: [{ run_id: "local" }] });
  status.mockResolvedValue("Queued");
  await expect(cancelStuckWorkflow("local")).rejects.toThrow("safely cancelled");
  status.mockResolvedValue("Cancelled");
  expect(await cancelStuckWorkflow("local")).toEqual({ runId: "local", alreadyTerminal: true });
  expect(cancel).not.toHaveBeenCalled();
  status.mockResolvedValue("Running");
  cancel.mockResolvedValue({ cancellationRequested: true });
  await cancelStuckWorkflow("local");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("local");
});
it("does not close reconciliation history until its provider run is terminal", async () => {
  query.mockResolvedValue({ rows: [{ workflow_run_id: "local" }] });
  status.mockResolvedValue("Running");
  await expect(closeStaleReconciliation("attempt")).rejects.toThrow("still active");
  expect(query).toHaveBeenCalledTimes(1);
  status.mockResolvedValue("Failed");
  query
    .mockResolvedValueOnce({ rows: [{ workflow_run_id: "local" }] })
    .mockResolvedValueOnce({ rowCount: 1 });
  expect(await closeStaleReconciliation("attempt")).toEqual({
    reconciliationId: "attempt",
    closed: true,
  });
});
