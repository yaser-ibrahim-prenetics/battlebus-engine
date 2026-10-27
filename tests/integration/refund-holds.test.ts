import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { ShopifyRefundCreatedEvent } from "@/inngest/events";
const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: getPool }));
import { getRefundHoldDecision } from "@/lib/services/refund-holds/decisions";

type Data = ShopifyRefundCreatedEvent["data"];
const event = (dates = {}): Data => ({
  shopifyStore: "hold-fixture",
  refundId: "123",
  shopifyOrderId: "456",
  receivedAt: new Date().toISOString(),
  refundJson: {
    id: 123,
    order_id: 456,
    created_at: new Date().toISOString(),
    ...dates,
    refund_line_items: [{ line_item: { fulfillment_status: null } }],
    transactions: [],
  } as Data["refundJson"],
});

describe.skipIf(!process.env.REFUND_HOLD_TEST_DATABASE_URL)("durable refund deadlines", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.REFUND_HOLD_TEST_DATABASE_URL });
  });
  beforeEach(async () => {
    getPool.mockResolvedValue(pool);
    await pool.query(
      "DELETE FROM public.refund_hold_decisions WHERE shop_domain LIKE 'hold-fixture%'"
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("uses processed_at + 24 hours and preserves it across concurrent retries and changed snapshots", async () => {
    const data = event({ processed_at: new Date(Date.now() - 3600000).toISOString() });
    const results = await Promise.all(Array.from({ length: 8 }, () => getRefundHoldDecision(data)));
    expect(new Set(results.map((r) => r.holdUntil)).size).toBe(1);
    expect(results[0]).toMatchObject({ waiting: true, unfulfilledLineCount: 1 });
    expect(Date.parse(results[0].holdUntil!)).toBe(
      Date.parse(data.refundJson.processed_at!) + 86400000
    );
    data.refundJson.refund_line_items = [];
    data.refundJson.processed_at = new Date(Date.now() + 86400000).toISOString();
    expect(await getRefundHoldDecision(data)).toEqual(results[0]);
  });
  it("persists a fixed first-seen deadline when timestamps are absent", async () => {
    const data = event({ created_at: undefined });
    const first = await getRefundHoldDecision(data);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await getRefundHoldDecision(data)).toEqual(first);
    const { rows } = await pool.query(
      "SELECT extract(epoch from (hold_until-raised_at)) AS seconds, timestamp_source FROM public.refund_hold_decisions WHERE shop_domain='hold-fixture'"
    );
    expect(rows[0]).toEqual({ seconds: "86400.000000", timestamp_source: "first_seen" });
  });
  it("does not restart an expired hold", async () => {
    const result = await getRefundHoldDecision(event({ created_at: "2020-01-01T00:00:00Z" }));
    expect(result).toMatchObject({ waiting: false, holdUntil: "2020-01-02T00:00:00.000Z" });
  });
  it("records no hold for amount-only and fully fulfilled refunds", async () => {
    const data = event();
    data.refundJson.refund_line_items = [];
    expect(await getRefundHoldDecision(data)).toMatchObject({ waiting: false, holdUntil: null });
    const full = event();
    full.refundId = "124";
    full.refundJson.id = 124;
    full.refundJson.refund_line_items[0].line_item.fulfillment_status = "fulfilled";
    expect(await getRefundHoldDecision(full)).toMatchObject({ waiting: false, holdUntil: null });
  });
  it("isolates stores and Loop IDs but rejects conflicting order identity", async () => {
    const first = event();
    await getRefundHoldDecision(first);
    const second = event({ created_at: "2020-01-01T00:00:00Z" });
    second.shopifyStore = "hold-fixture-other";
    expect((await getRefundHoldDecision(second)).waiting).toBe(false);
    second.shopifyStore = first.shopifyStore;
    second.refundInitiator = "loop_return_closed";
    expect((await getRefundHoldDecision(second)).waiting).toBe(false);
    first.shopifyOrderId = "999";
    first.refundJson.order_id = 999;
    await expect(getRefundHoldDecision(first)).rejects.toThrow("identity conflict");
  });
  it("fails closed when database access or payload identity is invalid", async () => {
    getPool.mockResolvedValue(null);
    await expect(getRefundHoldDecision(event())).rejects.toThrow("database is required");
    const data = event();
    data.refundId = "other";
    await expect(getRefundHoldDecision(data)).rejects.toThrow("ID does not match");
    data.refundId = "123";
    data.shopifyOrderId = "999";
    await expect(getRefundHoldDecision(data)).rejects.toThrow("order ID does not match");
  });
});
