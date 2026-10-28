import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/database", () => ({ queryDatabase: query }));
import { recordReconciliation } from "../record";
const context = { workflowRunId: "run", kind: "inventory" as const, scope: "test" };
beforeEach(() => query.mockReset().mockResolvedValue({ rowCount: 1 }));
describe("structured reconciliation attempts", () => {
  it("records a discrepancy before returning the result", async () => {
    const value = { count: 2 };
    expect(await recordReconciliation(context, async () => value, result => ({
      status: "discrepancies", result,
    }))).toEqual(value);
    expect(query.mock.calls[1][1].slice(1)).toEqual(["discrepancies", '{"count":2}', null]);
  });
  it("records failures without storing provider error text", async () => {
    await expect(recordReconciliation(context, async () => { throw new Error("secret"); },
      () => ({ status: "matched", result: {} }))).rejects.toThrow("secret");
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret");
    expect(query.mock.calls[1][1][1]).toBe("failed");
  });
  it("does not execute when the initial durable write fails", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    const execute = vi.fn();
    await expect(recordReconciliation(context, execute, () => ({ status: "matched", result: {} }))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not report success if the completion write is lost", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    await expect(recordReconciliation(context, async () => ({}), () => ({ status: "matched", result: {} }))).rejects.toThrow("completion");
  });
});
