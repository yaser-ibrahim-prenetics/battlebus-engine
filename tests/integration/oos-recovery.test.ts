import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeDatabase } from "@/lib/db/database";
import { executeOosDrain, oosInventoryKey } from "@/lib/services/oos-recovery/drain";
import { parkOosOrder } from "@/lib/services/oos-recovery/parking";
import { claimOosDrainRequest, submitOosDrainRequest } from "@/lib/services/oos-recovery/requests";
import type { InventoryDependency } from "@/lib/services/oos-recovery/inventory-failure";
import { queueHealthSQL } from "@/lib/sql/operations/health";

const connectionString = process.env.OOS_RECOVERY_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("targeted OOS recovery PostgreSQL contract", () => {
  let pool: Pool;
  const prefix = "oos-contract-";

  beforeAll(() => {
    if (process.env.DATABASE_URL !== connectionString) {
      throw new Error(
        "OOS integration tests require DATABASE_URL to match the disposable database"
      );
    }
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM public.oos_recovery_outbox WHERE event_data::text ILIKE $1", [
      `%${prefix}%`,
    ]);
    await pool.query("DELETE FROM public.oos_drain_requests WHERE lower(lane_key) LIKE $1", [
      `%${prefix}%`,
    ]);
    await pool.query("DELETE FROM public.oos_recovery_dependencies WHERE order_id LIKE $1", [
      `${prefix}%`,
    ]);
    await pool.query("DELETE FROM public.orders WHERE id LIKE $1", [`${prefix}%`]);
  });

  afterAll(async () => {
    await closeDatabase();
    await pool?.end();
  });

  function dependency(
    orderId: string,
    overrides: Partial<InventoryDependency> = {}
  ): InventoryDependency {
    const result: InventoryDependency = {
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}sku`,
      orderLineId: randomUUID(),
      quantityNeeded: 1,
      shopifyOrderId: orderId,
      shopifyOrderName: `#${orderId}`,
      shopifyStore: "im8health.myshopify.com",
      safeFailureCategory: "out_of_stock",
      ...overrides,
    };
    return {
      ...result,
      warehouse: result.warehouse.toUpperCase(),
      sku: result.sku.toUpperCase(),
    };
  }

  async function park(dependencies: InventoryDependency[], now: Date) {
    return parkOosOrder({
      dependencies,
      context: { maxRetries: 10 },
      retentionDays: 30,
      now,
    });
  }

  it("commits parked order lines and the notification outbox together", async () => {
    const orderId = `${prefix}atomic`;
    const result = await park(
      [
        dependency(orderId, { orderLineId: "duplicate-a", sku: `${prefix}same` }),
        dependency(orderId, { orderLineId: "duplicate-b", sku: `${prefix}same` }),
      ],
      new Date("2026-10-29T00:00:00.000Z")
    );

    const rows = await pool.query<{ order_line_id: string }>(
      `SELECT order_line_id FROM public.oos_recovery_dependencies
       WHERE order_id = $1 ORDER BY order_line_id`,
      [orderId]
    );
    const outbox = await pool.query<{ event_id: string; targeted: boolean }>(
      `SELECT event_id, (event_data->>'targetedRecovery')::boolean AS targeted
       FROM public.oos_recovery_outbox WHERE id = $1`,
      [result.outboxId]
    );
    const order = await pool.query<{ processing_status: string }>(
      "SELECT processing_status FROM public.orders WHERE id = $1",
      [orderId]
    );

    expect(rows.rows.map((row) => row.order_line_id)).toEqual(["duplicate-a", "duplicate-b"]);
    expect(outbox.rows[0]).toEqual({ event_id: result.eventId, targeted: true });
    expect(order.rows[0].processing_status).toBe("backorder");
  });

  it("keeps one leased active request and one coalesced successor per key", async () => {
    const key = {
      mode: "inventory_event" as const,
      dryRun: false,
      provider: "gps" as const,
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}coalesced`,
      observedQuantity: 1,
      observedAt: "2026-10-29T00:00:00.000Z",
      sourceEventId: `${prefix}observation-1`,
      batchLimit: 100,
    };
    const first = await submitOosDrainRequest(key);
    expect(await claimOosDrainRequest(first.request.id, 300)).not.toBeNull();

    await Promise.all([
      submitOosDrainRequest({
        ...key,
        sourceEventId: `${prefix}observation-2`,
        observedQuantity: 2,
      }),
      submitOosDrainRequest({
        ...key,
        sourceEventId: `${prefix}observation-3`,
        observedQuantity: 3,
      }),
    ]);

    const open = await pool.query<{ slot: string; status: string }>(
      `SELECT slot, status FROM public.oos_drain_requests
       WHERE lane_key = $1 AND status IN ('queued', 'leased') ORDER BY slot`,
      [first.request.laneKey]
    );
    expect(open.rows).toEqual([
      { slot: "active", status: "leased" },
      { slot: "successor", status: "queued" },
    ]);
  });

  it("allocates live retries FIFO without partially waking a multi-SKU order", async () => {
    const olderId = `${prefix}older`;
    const newerId = `${prefix}newer`;
    const blockedId = `${prefix}multi`;
    await park([dependency(olderId, { quantityNeeded: 2 })], new Date("2026-10-29T00:00:00Z"));
    await park([dependency(newerId, { quantityNeeded: 2 })], new Date("2026-10-29T01:00:00Z"));
    await park(
      [
        dependency(blockedId, { sku: `${prefix}sku`, orderLineId: "multi-a" }),
        dependency(blockedId, { sku: `${prefix}missing`, orderLineId: "multi-b" }),
      ],
      new Date("2026-10-29T02:00:00Z")
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}sku`,
      batchLimit: 10,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a drain request lease");

    const result = await executeOosDrain(request, async (rows) => {
      const availability = new Map<string, number>();
      for (const row of rows) {
        availability.set(oosInventoryKey(row), row.sku.endsWith("MISSING") ? 0 : 3);
      }
      return availability;
    });

    expect(result.selectedOrders).toBe(1);
    const states = await pool.query<{ order_id: string; status: string }>(
      `SELECT order_id, status FROM public.oos_recovery_dependencies
       WHERE order_id = ANY($1::text[]) ORDER BY order_id, order_line_id`,
      [[olderId, newerId, blockedId]]
    );
    expect(states.rows.filter((row) => row.order_id === olderId).map((row) => row.status)).toEqual([
      "retrying",
    ]);
    expect(states.rows.filter((row) => row.order_id === newerId).map((row) => row.status)).toEqual([
      "parked",
    ]);
    expect(
      states.rows.filter((row) => row.order_id === blockedId).map((row) => row.status)
    ).toEqual(["parked", "parked"]);
  });

  it("runs dry selection without mutating dependencies or publishing retries", async () => {
    const orderId = `${prefix}dry`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const before = await pool.query<{ dependencies: string; outbox: string }>(
      `SELECT
         (SELECT count(*)::text FROM public.oos_recovery_dependencies WHERE order_id = $1) AS dependencies,
         (SELECT count(*)::text FROM public.oos_recovery_outbox WHERE event_id LIKE 'oos-retry-%') AS outbox`,
      [orderId]
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: true,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}sku`,
      batchLimit: 10,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a dry-run request lease");
    const result = await executeOosDrain(
      request,
      async (rows) => new Map(rows.map((row) => [oosInventoryKey(row), 100]))
    );
    const after = await pool.query<{ status: string; outbox: string }>(
      `SELECT
         (SELECT status FROM public.oos_recovery_dependencies WHERE order_id = $1) AS status,
         (SELECT count(*)::text FROM public.oos_recovery_outbox WHERE event_id LIKE 'oos-retry-%') AS outbox`,
      [orderId]
    );

    expect(result.selectedOrders).toBe(1);
    expect(after.rows[0]).toEqual({ status: "parked", outbox: before.rows[0].outbox });
  });

  it("exposes bounded queue health and manual-review evidence", async () => {
    const health = await pool.query(queueHealthSQL);
    expect(health.rows[0]).toEqual(
      expect.objectContaining({
        oos_parked_count: expect.any(Number),
        oos_due_age_seconds: expect.any(Number),
        oos_manual_review_count: expect.any(Number),
        oos_expired_lease_count: expect.any(Number),
        oos_outbox_exhausted_count: expect.any(Number),
      })
    );
  });
});
