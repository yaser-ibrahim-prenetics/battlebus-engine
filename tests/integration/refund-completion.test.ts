import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/database")>()),
  isDatabaseConfigured: () => true,
  queryDatabase: query,
}));
import { hasCompletedRefundFlowLog } from "@/lib/services/flow-logs";

const refundId = "refund-completion-fixture";
describe.skipIf(!process.env.REFUND_HOLD_TEST_DATABASE_URL)("post-hold completion lookup", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.REFUND_HOLD_TEST_DATABASE_URL });
    query.mockImplementation((text, values) => pool.query(text, values));
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM public.flow_logs WHERE payload->>'refundId' = $1", [refundId]);
  });
  afterAll(async () => {
    await pool?.query("DELETE FROM public.flow_logs WHERE payload->>'refundId' = $1", [refundId]);
    await pool?.end();
  });
  async function completed(runId: string | null) {
    await pool.query(
      `INSERT INTO public.flow_logs (flow, step, status, run_id, payload)
      VALUES ('refund', 'refund_line_created', 'completed', $1, $2::jsonb)`,
      [runId, JSON.stringify({ refundId })]
    );
  }
  it("lets the same run finish its line, but stops another run after the hold", async () => {
    await completed("original-run");
    expect(await hasCompletedRefundFlowLog(refundId)).toBe(true);
    expect(await hasCompletedRefundFlowLog(refundId, "original-run")).toBe(false);
    expect(await hasCompletedRefundFlowLog(refundId, "another-run")).toBe(true);
    await completed("another-run");
    expect(await hasCompletedRefundFlowLog(refundId, "original-run")).toBe(true);
  });
  it("still detects historical completion rows with no run ID", async () => {
    await completed(null);
    expect(await hasCompletedRefundFlowLog(refundId, "current-run")).toBe(true);
    expect(await hasCompletedRefundFlowLog("different-refund", "current-run")).toBe(false);
  });
});
