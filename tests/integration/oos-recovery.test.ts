import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { closeDatabase } from "@/lib/db/database";
import { executeOosDrain, oosInventoryKey } from "@/lib/services/oos-recovery/drain";
import { parkOosOrder } from "@/lib/services/oos-recovery/parking";
import {
  claimOosDrainRequest,
  createOosDrainPreviewRequest,
  OosDrainCommandConflictError,
  redispatchStalledOosDrainRequests,
  reserveOosDrainPreviewCommand,
  finishOosDrainPreviewCommand,
  submitOosDrainRequest,
} from "@/lib/services/oos-recovery/requests";
import {
  claimOosRecoveryMutation,
  isCurrentOosRecoveryAttempt,
  loadOosRetryContext,
  moveOosDependenciesToManualReview,
  rearmManualReviewOosDependencies,
  reparkOosDependencies,
  releaseOosRecoveryMutation,
  renewOosRecoveryMutation,
  resolveOosDependencies,
} from "@/lib/services/oos-recovery/outcomes";
import type { InventoryDependency } from "@/lib/services/oos-recovery/inventory-failure";
import { queueHealthSQL } from "@/lib/sql/operations/health";
import { claimOosOutboxEntries } from "@/lib/services/oos-recovery/outbox";

const connectionString = process.env.OOS_RECOVERY_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("targeted OOS recovery PostgreSQL contract", () => {
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  const prefix = "oos-contract-";

  beforeAll(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = connectionString;
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM public.oos_recovery_mutation_leases WHERE order_id LIKE $1", [
      `${prefix}%`,
    ]);
    await pool.query("DELETE FROM public.oos_recovery_outbox WHERE event_data::text ILIKE $1", [
      `%${prefix}%`,
    ]);
    await pool.query(
      "DELETE FROM public.oos_drain_command_receipts WHERE lower(lane_key) LIKE $1",
      [`%${prefix}%`]
    );
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
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
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

  async function retryContext(orderId: string, includeManualReview = false) {
    const context = await loadOosRetryContext({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      includeManualReview,
    });
    if (!context) throw new Error(`expected OOS retry context for ${orderId}`);
    return context;
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
    await expect(
      loadOosRetryContext({
        shopifyStore: "im8health.myshopify.com",
        orderId,
      })
    ).resolves.toEqual({
      provider: "gps",
      warehouse: `${prefix}warehouse`.toUpperCase(),
      blockedItems: [
        { orderLineId: "duplicate-a", providerSku: `${prefix}same`.toUpperCase() },
        { orderLineId: "duplicate-b", providerSku: `${prefix}same`.toUpperCase() },
      ],
      manualReview: false,
      attemptToken: null,
    });
  });

  it("exhausts an expired outbox lease at the configured attempt ceiling", async () => {
    const orderId = `${prefix}outbox-expired-lease`;
    const parked = await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    await pool.query(
      `UPDATE public.oos_recovery_outbox
       SET status = 'leased', attempt_count = 3, lease_token = gen_random_uuid(),
         lease_until = now() - interval '1 minute'
       WHERE id = $1`,
      [parked.outboxId]
    );

    await expect(claimOosOutboxEntries(10, 30, 3)).resolves.toEqual([]);
    const state = await pool.query<{
      status: string;
      lease_token: string | null;
      next_attempt_at: string;
      last_error_code: string;
    }>(
      `SELECT status, lease_token, next_attempt_at::text, last_error_code
       FROM public.oos_recovery_outbox WHERE id = $1`,
      [parked.outboxId]
    );
    expect(state.rows[0]).toEqual({
      status: "failed",
      lease_token: null,
      next_attempt_at: "infinity",
      last_error_code: "lease_attempts_exhausted",
    });
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

  it("does not replay an order while any unresolved line needs manual review", async () => {
    const orderId = `${prefix}mixed-manual-review`;
    await park(
      [
        dependency(orderId, { sku: `${prefix}ready`, orderLineId: "ready-line" }),
        dependency(orderId, { sku: `${prefix}manual`, orderLineId: "manual-line" }),
      ],
      new Date("2026-10-29T00:00:00Z")
    );
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET status = 'manual_review', manual_review_at = now()
       WHERE order_id = $1 AND order_line_id = 'manual-line'`,
      [orderId]
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}ready`,
      batchLimit: 1,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a drain request lease");

    const result = await executeOosDrain(
      request,
      async (rows) => new Map(rows.map((row) => [oosInventoryKey(row), 100]))
    );
    expect(result.selectedOrders).toBe(0);
  });

  it("matches provider, warehouse, and SKU on the same dependency row", async () => {
    const orderId = `${prefix}tuple-target`;
    await park(
      [
        dependency(orderId, {
          provider: "gps",
          warehouse: `${prefix}warehouse-a`,
          sku: `${prefix}sku-a`,
          orderLineId: "tuple-a",
        }),
        dependency(orderId, {
          provider: "d365",
          warehouse: `${prefix}warehouse-b`,
          sku: `${prefix}sku-b`,
          orderLineId: "tuple-b",
        }),
      ],
      new Date("2026-10-29T00:00:00Z")
    );
    const request = createOosDrainPreviewRequest({
      mode: "manual",
      dryRun: true,
      provider: "gps",
      warehouse: `${prefix}warehouse-b`,
      sku: `${prefix}sku-b`,
      batchLimit: 10,
    });
    const result = await executeOosDrain(
      request,
      async (rows) => new Map(rows.map((row) => [oosInventoryKey(row), 100]))
    );

    expect(result.selectedOrders).toBe(0);
  });

  it("runs dry selection without mutating dependencies or publishing retries", async () => {
    const orderId = `${prefix}dry`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const before = await pool.query<{ dependencies: string; outbox: string; requests: string }>(
      `SELECT
         (SELECT count(*)::text FROM public.oos_recovery_dependencies WHERE order_id = $1) AS dependencies,
         (SELECT count(*)::text FROM public.oos_recovery_outbox) AS outbox,
         (SELECT count(*)::text FROM public.oos_drain_requests) AS requests`,
      [orderId]
    );
    const request = createOosDrainPreviewRequest({
      mode: "manual",
      dryRun: true,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}sku`,
      batchLimit: 10,
    });
    const result = await executeOosDrain(
      request,
      async (rows) => new Map(rows.map((row) => [oosInventoryKey(row), 100]))
    );
    const after = await pool.query<{ status: string; outbox: string; requests: string }>(
      `SELECT
         (SELECT status FROM public.oos_recovery_dependencies WHERE order_id = $1) AS status,
         (SELECT count(*)::text FROM public.oos_recovery_outbox) AS outbox,
         (SELECT count(*)::text FROM public.oos_drain_requests) AS requests`,
      [orderId]
    );

    expect(result.selectedOrders).toBe(1);
    expect(after.rows[0]).toEqual({
      status: "parked",
      outbox: before.rows[0].outbox,
      requests: before.rows[0].requests,
    });
  });

  it("serializes independent lanes that compete for the same provider inventory", async () => {
    const firstOrderId = `${prefix}concurrent-a`;
    const secondOrderId = `${prefix}concurrent-b`;
    await park([dependency(firstOrderId)], new Date("2026-10-29T00:00:00Z"));
    await park([dependency(secondOrderId)], new Date("2026-10-29T00:01:00Z"));
    const firstSubmission = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      orderId: firstOrderId,
      shopifyStore: "im8health.myshopify.com",
      batchLimit: 1,
    });
    const secondSubmission = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      orderId: secondOrderId,
      shopifyStore: "im8health.myshopify.com",
      batchLimit: 1,
    });
    const [firstRequest, secondRequest] = await Promise.all([
      claimOosDrainRequest(firstSubmission.request.id, 300),
      claimOosDrainRequest(secondSubmission.request.id, 300),
    ]);
    if (!firstRequest || !secondRequest) throw new Error("expected both drain request leases");
    const inventoryReader = async (rows: Parameters<typeof oosInventoryKey>[0][]) =>
      new Map(rows.map((row) => [oosInventoryKey(row), 1]));

    const results = await Promise.all([
      executeOosDrain(firstRequest, inventoryReader),
      executeOosDrain(secondRequest, inventoryReader),
    ]);
    const retrying = await pool.query<{ order_id: string }>(
      `SELECT order_id FROM public.oos_recovery_dependencies
       WHERE order_id = ANY($1::text[]) AND status = 'retrying'`,
      [[firstOrderId, secondOrderId]]
    );

    expect(results.reduce((sum, result) => sum + result.selectedOrders, 0)).toBe(1);
    expect(retrying.rowCount).toBe(1);
  });

  it("redispatches an expired request lease with a fresh durable event identity", async () => {
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}redispatch`,
      batchLimit: 1,
    });
    await pool.query(
      `UPDATE public.oos_recovery_outbox
       SET status = 'published', published_at = now()
       WHERE event_data->>'requestId' = $1`,
      [submitted.request.id]
    );
    expect(await claimOosDrainRequest(submitted.request.id, 30)).not.toBeNull();
    await pool.query(
      `UPDATE public.oos_drain_requests SET lease_until = now() - interval '1 second'
       WHERE id = $1`,
      [submitted.request.id]
    );

    await expect(redispatchStalledOosDrainRequests(10, 10)).resolves.toBeGreaterThanOrEqual(1);
    const savedRequest = await pool.query<{ status: string; dispatch_count: number }>(
      "SELECT status, dispatch_count FROM public.oos_drain_requests WHERE id = $1",
      [submitted.request.id]
    );
    const events = await pool.query<{ event_id: string }>(
      `SELECT event_id FROM public.oos_recovery_outbox
       WHERE event_data->>'requestId' = $1 ORDER BY event_id`,
      [submitted.request.id]
    );

    expect(savedRequest.rows[0]).toEqual({ status: "queued", dispatch_count: 2 });
    expect(events.rows).toHaveLength(2);
    expect(new Set(events.rows.map((row) => row.event_id)).size).toBe(2);
  });

  it("bounds expired-lease recovery and terminalizes requests at the attempt limit", async () => {
    const submitted = [];
    for (let index = 0; index < 3; index++) {
      const request = await submitOosDrainRequest({
        mode: "manual",
        dryRun: false,
        provider: "gps",
        warehouse: `${prefix}warehouse`,
        sku: `${prefix}bounded-lease-${index}`,
        batchLimit: 1,
      });
      await pool.query(
        `UPDATE public.oos_recovery_outbox
         SET status = 'published', published_at = now()
         WHERE event_data->>'requestId' = $1`,
        [request.request.id]
      );
      expect(await claimOosDrainRequest(request.request.id, 30)).not.toBeNull();
      await pool.query(
        `UPDATE public.oos_drain_requests
         SET lease_until = now() - interval '1 second', attempt_count = 1
         WHERE id = $1`,
        [request.request.id]
      );
      submitted.push(request.request.id);
    }

    await expect(redispatchStalledOosDrainRequests(1, 1)).resolves.toBe(0);
    const states = await pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM public.oos_drain_requests
       WHERE id = ANY($1::uuid[]) GROUP BY status ORDER BY status`,
      [submitted]
    );
    expect(states.rows).toEqual([
      { status: "failed", count: 1 },
      { status: "leased", count: 2 },
    ]);
  });

  it("does not duplicate an outstanding dispatch and fails visibly after outbox exhaustion", async () => {
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      provider: "gps",
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}outage`,
      batchLimit: 1,
    });
    await pool.query(
      "UPDATE public.oos_drain_requests SET last_error_code = 'lease_expired' WHERE id = $1",
      [submitted.request.id]
    );

    await expect(redispatchStalledOosDrainRequests(10, 10)).resolves.toBe(0);
    const beforeExhaustion = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.oos_recovery_outbox
       WHERE event_data->>'requestId' = $1`,
      [submitted.request.id]
    );
    expect(beforeExhaustion.rows[0].count).toBe("1");

    await pool.query(
      `UPDATE public.oos_recovery_outbox
       SET status = 'failed', next_attempt_at = 'infinity'::timestamptz,
         last_error_code = 'delivery_exhausted'
       WHERE event_data->>'requestId' = $1`,
      [submitted.request.id]
    );
    await expect(redispatchStalledOosDrainRequests(10, 10)).resolves.toBe(0);
    const failed = await pool.query<{ status: string; last_error_code: string }>(
      "SELECT status, last_error_code FROM public.oos_drain_requests WHERE id = $1",
      [submitted.request.id]
    );
    expect(failed.rows[0]).toEqual({ status: "failed", last_error_code: "outbox_exhausted" });
  });

  it("preserves immutable command receipts across coalescing and rejects UUID reuse", async () => {
    const input = {
      mode: "manual" as const,
      dryRun: false,
      provider: "gps" as const,
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}command`,
      batchLimit: 1,
    };
    const command = {
      requestId: randomUUID(),
      actor: "service:battle-bus-operations",
      reason: "Operator verified restored inventory for this exact key",
    };
    const first = await submitOosDrainRequest(input, command);
    const replay = await submitOosDrainRequest(input, command);
    expect(replay.request.id).toBe(first.request.id);
    await expect(
      submitOosDrainRequest(input, { ...command, reason: "Conflicting request parameters" })
    ).rejects.toBeInstanceOf(OosDrainCommandConflictError);
    const receipts = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.oos_drain_command_receipts WHERE request_id = $1",
      [command.requestId]
    );
    expect(receipts.rows[0].count).toBe("1");
  });

  it("returns the saved aggregate result for an idempotent preview command", async () => {
    const input = {
      mode: "manual" as const,
      dryRun: true,
      provider: "gps" as const,
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}preview-command`,
      batchLimit: 1,
    };
    const command = {
      requestId: randomUUID(),
      actor: "service:battle-bus-operations",
      reason: "Operator requested a bounded inventory recovery preview",
    };
    const reservation = await reserveOosDrainPreviewCommand(input, command);
    expect(reservation).toEqual({
      status: "execute",
      executionToken: expect.any(String),
    });
    if (reservation.status !== "execute") throw new Error("expected a preview execution lease");
    const evidence = {
      examinedOrders: 3,
      selectedOrders: 1,
      selectedDependencies: 2,
      manualReviewExpired: 0,
      queuedKeys: 0,
    };
    await expect(
      finishOosDrainPreviewCommand({
        requestId: command.requestId,
        executionToken: reservation.executionToken,
        result: evidence,
      })
    ).resolves.toBe(true);
    await expect(reserveOosDrainPreviewCommand(input, command)).resolves.toEqual({
      status: "completed",
      result: evidence,
    });
  });

  it("prevents a stale preview attempt from overwriting a reclaimed execution", async () => {
    const input = {
      mode: "manual" as const,
      dryRun: true,
      provider: "gps" as const,
      warehouse: `${prefix}warehouse`,
      sku: `${prefix}preview-lease`,
      batchLimit: 1,
    };
    const command = {
      requestId: randomUUID(),
      actor: "service:battle-bus-operations",
      reason: "Operator requested a lease-protected inventory preview",
    };
    const first = await reserveOosDrainPreviewCommand(input, command);
    if (first.status !== "execute") throw new Error("expected the first preview lease");
    await pool.query(
      `UPDATE public.oos_drain_command_receipts
       SET preview_started_at = now() - interval '6 minutes'
       WHERE request_id = $1`,
      [command.requestId]
    );
    const second = await reserveOosDrainPreviewCommand(input, command);
    if (second.status !== "execute") throw new Error("expected the reclaimed preview lease");
    expect(second.executionToken).not.toBe(first.executionToken);
    await expect(
      finishOosDrainPreviewCommand({
        requestId: command.requestId,
        executionToken: first.executionToken,
        errorCode: "stale_attempt",
      })
    ).resolves.toBe(false);
    await expect(
      finishOosDrainPreviewCommand({
        requestId: command.requestId,
        executionToken: second.executionToken,
        result: {
          examinedOrders: 0,
          selectedOrders: 0,
          selectedDependencies: 0,
          manualReviewExpired: 0,
          queuedKeys: 0,
        },
      })
    ).resolves.toBe(true);
  });

  it("moves expired dependencies to review in bounded batches", async () => {
    const orderIds = [0, 1, 2].map((index) => `${prefix}expired-${index}`);
    for (const [index, orderId] of orderIds.entries()) {
      await park([dependency(orderId)], new Date(`2026-10-29T00:0${index}:00Z`));
    }
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET expires_at = now() - interval '1 minute'
       WHERE order_id = ANY($1::text[])`,
      [orderIds]
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      orderId: orderIds[0],
      shopifyStore: "im8health.myshopify.com",
      batchLimit: 1,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a drain request lease");
    await executeOosDrain(request, async () => new Map());

    const states = await pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM public.oos_recovery_dependencies
       WHERE order_id = ANY($1::text[]) GROUP BY status ORDER BY status`,
      [orderIds]
    );
    expect(states.rows).toEqual([
      { status: "manual_review", count: 1 },
      { status: "parked", count: 2 },
    ]);
  });

  it("expires every dependency on an order when any one line expires", async () => {
    const orderId = `${prefix}expired-complete-order`;
    await park(
      [
        dependency(orderId, { orderLineId: "line-a", sku: "SKU-A" }),
        dependency(orderId, { orderLineId: "line-b", sku: "SKU-B" }),
      ],
      new Date("2026-10-29T00:00:00Z")
    );
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET expires_at = CASE
         WHEN order_line_id = 'line-a' THEN now() - interval '1 minute'
         ELSE now() + interval '1 day'
       END
       WHERE order_id = $1`,
      [orderId]
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      orderId,
      shopifyStore: "im8health.myshopify.com",
      batchLimit: 1,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a drain request lease");
    const result = await executeOosDrain(request, async () => new Map());

    expect(result.manualReviewExpired).toBe(2);
    const states = await pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count
       FROM public.oos_recovery_dependencies WHERE order_id = $1 GROUP BY status`,
      [orderId]
    );
    expect(states.rows).toEqual([{ status: "manual_review", count: 2 }]);
  });

  it("lets an explicit Hub retry rearm a manual-review dependency", async () => {
    const orderId = `${prefix}manual-rearm`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const firstAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!firstAttempt) throw new Error("expected the first replay attempt token");
    await moveOosDependenciesToManualReview({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken: firstAttempt,
      expectedContext: await retryContext(orderId),
      errorCode: "provider_rejected",
    });

    await expect(
      loadOosRetryContext({ shopifyStore: "im8health.myshopify.com", orderId })
    ).resolves.toBeNull();
    const context = await loadOosRetryContext({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      includeManualReview: true,
    });
    expect(context?.manualReview).toBe(true);
    const secondAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    expect(secondAttempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondAttempt).not.toBe(firstAttempt);
    const dependencyState = await pool.query<{
      status: string;
      manual_review_at: Date | null;
      replay_token: string;
    }>(
      `SELECT status, manual_review_at, replay_token
       FROM public.oos_recovery_dependencies WHERE order_id = $1`,
      [orderId]
    );
    expect(dependencyState.rows[0]).toEqual({
      status: "retrying",
      manual_review_at: null,
      replay_token: secondAttempt,
    });
  });

  it("rearms the complete order when review and retrying rows are mixed", async () => {
    const orderId = `${prefix}mixed-rearm`;
    await park(
      [
        dependency(orderId, { orderLineId: "line-a", sku: "SKU-A" }),
        dependency(orderId, { orderLineId: "line-b", sku: "SKU-B" }),
      ],
      new Date("2026-10-29T00:00:00Z")
    );
    const firstAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!firstAttempt) throw new Error("expected a replay attempt token");
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET status = 'manual_review', manual_review_at = now()
       WHERE order_id = $1 AND order_line_id = 'line-a'`,
      [orderId]
    );

    const secondAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    expect(secondAttempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondAttempt).not.toBe(firstAttempt);
    const states = await pool.query<{ status: string; replay_token: string; count: number }>(
      `SELECT status, replay_token, count(*)::int AS count
       FROM public.oos_recovery_dependencies WHERE order_id = $1
       GROUP BY status, replay_token`,
      [orderId]
    );
    expect(states.rows).toEqual([{ status: "retrying", replay_token: secondAttempt, count: 2 }]);
  });

  it("lets the same correlated replay resolve a prior manual-review outcome", async () => {
    const orderId = `${prefix}manual-resolve`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const attemptToken = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!attemptToken) throw new Error("expected a replay attempt token");
    await moveOosDependenciesToManualReview({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken,
      expectedContext: await retryContext(orderId),
      errorCode: "transient_downstream_failure",
    });
    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext: await retryContext(orderId, true),
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 1, manualReview: false });
  });

  it("does not let an older replay resolve a newer recovery attempt", async () => {
    const orderId = `${prefix}stale-replay`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const olderAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!olderAttempt) throw new Error("expected an older replay attempt token");
    await moveOosDependenciesToManualReview({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken: olderAttempt,
      expectedContext: await retryContext(orderId),
      errorCode: "older_attempt_failed",
    });
    const newerAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!newerAttempt) throw new Error("expected a newer replay attempt token");

    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken: olderAttempt,
        expectedContext: await retryContext(orderId),
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 0, manualReview: false });
    const state = await pool.query<{ status: string; replay_token: string }>(
      `SELECT status, replay_token
       FROM public.oos_recovery_dependencies WHERE order_id = $1`,
      [orderId]
    );
    expect(state.rows[0]).toEqual({ status: "retrying", replay_token: newerAttempt });
  });

  it("rejects a partial stale-token outcome without resolving the order", async () => {
    const orderId = `${prefix}partial-stale-replay`;
    await park(
      [
        dependency(orderId, { orderLineId: "line-a", sku: "SKU-A" }),
        dependency(orderId, { orderLineId: "line-b", sku: "SKU-B" }),
      ],
      new Date("2026-10-29T00:00:00Z")
    );
    const attemptToken = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!attemptToken) throw new Error("expected a replay attempt token");
    const expectedContext = await retryContext(orderId);
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET replay_token = $2::uuid, version = version + 1
       WHERE order_id = $1 AND order_line_id = 'line-b'`,
      [orderId, randomUUID()]
    );

    await expect(
      isCurrentOosRecoveryAttempt({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
      })
    ).resolves.toBe(false);
    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 0, manualReview: false });
    const states = await pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count
       FROM public.oos_recovery_dependencies WHERE order_id = $1
       GROUP BY status`,
      [orderId]
    );
    expect(states.rows).toEqual([{ status: "retrying", count: 2 }]);
    const order = await pool.query<{ processing_status: string }>(
      `SELECT processing_status FROM public.orders WHERE id = $1`,
      [orderId]
    );
    expect(order.rows[0]?.processing_status).toBe("backorder");
  });

  it("blocks invalidation while an exact provider mutation lease is active", async () => {
    const orderId = `${prefix}mutation-lease`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const attemptToken = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!attemptToken) throw new Error("expected a replay attempt token");
    const expectedContext = await retryContext(orderId);
    const leaseClaim = await claimOosRecoveryMutation({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken,
      expectedContext,
      operationKey: "d365:test-primary",
      leaseOwner: "integration-test",
      leaseSeconds: 300,
    });
    if (leaseClaim.status !== "claimed") throw new Error("expected a provider mutation lease");
    const lease = leaseClaim.lease;
    const concurrentClaim = await claimOosRecoveryMutation({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken,
      expectedContext,
      operationKey: "d365:test-concurrent",
      leaseOwner: "integration-test-concurrent",
      leaseSeconds: 300,
    });
    if (concurrentClaim.status !== "claimed") {
      throw new Error("expected a concurrent same-attempt lease");
    }
    const concurrentLease = concurrentClaim.lease;
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        operationKey: "d365:test-primary",
        leaseOwner: "integration-test-retry",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({ status: "blocked" });
    const rejectedClaim = await claimOosRecoveryMutation({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken,
      expectedContext,
      operationKey: "d365:test-rejected",
      leaseOwner: "integration-test-rejected",
      leaseSeconds: 300,
    });
    if (rejectedClaim.status !== "claimed") {
      throw new Error("expected an inventory-rejected provider mutation lease");
    }
    const rejectedLease = rejectedClaim.lease;
    await expect(
      releaseOosRecoveryMutation(rejectedLease, {
        state: "rejected",
        failure: {
          provider: "d365",
          category: "inventory_insufficient",
          message: "provider-confirmed inventory rejection",
          blockedItems: [],
        },
      })
    ).resolves.toBe(true);
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        operationKey: "d365:test-rejected",
        leaseOwner: "integration-test-rejected-resume",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({
      status: "rejected",
      failure: {
        provider: "d365",
        category: "inventory_insufficient",
        message: "provider-confirmed inventory rejection",
        blockedItems: [],
      },
    });
    await pool.query(
      `UPDATE public.oos_recovery_mutation_leases
       SET lease_until = now() + interval '1 second' WHERE id = $1::uuid`,
      [lease.leaseToken]
    );
    await expect(renewOosRecoveryMutation(lease, 300)).resolves.toBe(true);
    const renewed = await pool.query<{ renewed: boolean }>(
      `SELECT lease_until > now() + interval '4 minutes' AS renewed
       FROM public.oos_recovery_mutation_leases WHERE id = $1::uuid`,
      [lease.leaseToken]
    );
    expect(renewed.rows).toEqual([{ renewed: true }]);
    const uncertainClaim = await claimOosRecoveryMutation({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken,
      expectedContext,
      operationKey: "d365:test-uncertain",
      leaseOwner: "integration-test-uncertain",
      leaseSeconds: 300,
    });
    if (uncertainClaim.status !== "claimed") {
      throw new Error("expected an uncertain provider mutation lease");
    }
    const uncertainLease = uncertainClaim.lease;
    await pool.query(
      `UPDATE public.oos_recovery_mutation_leases
       SET created_at = now() - interval '10 minutes', lease_until = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [uncertainLease.leaseToken]
    );
    await expect(releaseOosRecoveryMutation(uncertainLease)).resolves.toBe(false);
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        operationKey: "d365:test-uncertain",
        leaseOwner: "integration-test-uncertain-retry",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({ status: "blocked" });

    await expect(
      rearmManualReviewOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        retentionDays: 30,
      })
    ).resolves.toBeNull();
    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 0, manualReview: false });
    await expect(
      parkOosOrder({
        dependencies: [dependency(orderId, { provider: "d365", sku: "D365-SKU" })],
        context: {
          maxRetries: 10,
          resolvedProviderBeforeParking: expectedContext.provider,
          resolvedReplayToken: attemptToken,
          resolvedAttemptContext: expectedContext,
        },
        retentionDays: 30,
      })
    ).rejects.toThrow("provider mutation lease is active");
    await pool.query(
      `UPDATE public.oos_recovery_dependencies
       SET expires_at = now() - interval '1 minute' WHERE order_id = $1`,
      [orderId]
    );
    const submitted = await submitOosDrainRequest({
      mode: "manual",
      dryRun: false,
      orderId,
      shopifyStore: "im8health.myshopify.com",
      batchLimit: 1,
    });
    const request = await claimOosDrainRequest(submitted.request.id, 300);
    if (!request) throw new Error("expected a drain request lease");
    await expect(executeOosDrain(request, async () => new Map())).resolves.toMatchObject({
      manualReviewExpired: 0,
    });
    await expect(releaseOosRecoveryMutation(lease)).resolves.toBe(true);
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        operationKey: "d365:test-primary",
        leaseOwner: "integration-test-completed-retry",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({ status: "accepted", result: { hasValue: false } });
    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 0, manualReview: false });
    await expect(releaseOosRecoveryMutation(concurrentLease)).resolves.toBe(true);
    await expect(
      resolveOosDependencies({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken,
        expectedContext,
        includeManualReview: true,
      })
    ).resolves.toEqual({ dependencies: 1, manualReview: false });

    await park([dependency(orderId)], new Date("2026-10-29T00:01:00Z"));
    const nextAttemptToken = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!nextAttemptToken) throw new Error("expected a later replay attempt token");
    const nextExpectedContext = await retryContext(orderId);
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken: nextAttemptToken,
        expectedContext: nextExpectedContext,
        operationKey: "d365:test-primary",
        leaseOwner: "integration-test-later-d365:test-primary",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({ status: "accepted", result: { hasValue: false } });
    await expect(
      claimOosRecoveryMutation({
        shopifyStore: "im8health.myshopify.com",
        orderId,
        attemptToken: nextAttemptToken,
        expectedContext: nextExpectedContext,
        operationKey: "d365:test-uncertain",
        leaseOwner: "integration-test-later-d365:test-uncertain",
        leaseSeconds: 300,
      })
    ).resolves.toEqual({ status: "blocked" });
    const retryAfterInventoryRejectionClaim = await claimOosRecoveryMutation({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken: nextAttemptToken,
      expectedContext: nextExpectedContext,
      operationKey: "d365:test-rejected",
      leaseOwner: "integration-test-rejected-later",
      leaseSeconds: 300,
    });
    if (retryAfterInventoryRejectionClaim.status !== "claimed") {
      throw new Error("expected an inventory-rejected operation to be retryable later");
    }
    const retryAfterInventoryRejection = retryAfterInventoryRejectionClaim.lease;
    await expect(releaseOosRecoveryMutation(retryAfterInventoryRejection)).resolves.toBe(true);
  });

  it("preserves the attempt ceiling across repeated same-provider failures", async () => {
    const orderId = `${prefix}same-provider-ceiling`;
    await park([dependency(orderId)], new Date("2026-10-29T00:00:00Z"));
    const firstAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!firstAttempt) throw new Error("expected a first replay attempt token");
    await reparkOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken: firstAttempt,
      expectedContext: await retryContext(orderId),
      cooldownSeconds: 1,
      maxAttempts: 2,
      errorCode: "inventory_insufficient",
    });
    const secondAttempt = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!secondAttempt) throw new Error("expected a second replay attempt token");
    await reparkOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      attemptToken: secondAttempt,
      expectedContext: await retryContext(orderId),
      cooldownSeconds: 1,
      maxAttempts: 2,
      errorCode: "inventory_insufficient",
    });

    const state = await pool.query<{
      status: string;
      attempt_count: number;
      replay_token: string;
    }>(
      `SELECT status, attempt_count, replay_token
       FROM public.oos_recovery_dependencies WHERE order_id = $1`,
      [orderId]
    );
    expect(state.rows[0]).toEqual({
      status: "manual_review",
      attempt_count: 2,
      replay_token: secondAttempt,
    });
  });

  it("atomically resolves the recovered provider before parking a downstream failure", async () => {
    const orderId = `${prefix}provider-rollover`;
    await park(
      [dependency(orderId, { provider: "d365", warehouse: "U001", sku: "D365-SKU" })],
      new Date("2026-10-29T00:00:00Z")
    );
    const attemptToken = await rearmManualReviewOosDependencies({
      shopifyStore: "im8health.myshopify.com",
      orderId,
      retentionDays: 30,
    });
    if (!attemptToken) throw new Error("expected a replay attempt token");
    const resolvedAttemptContext = await retryContext(orderId);
    await parkOosOrder({
      dependencies: [dependency(orderId, { provider: "gps", sku: "GPS-SKU" })],
      context: {
        maxRetries: 10,
        resolvedProviderBeforeParking: "d365",
        resolvedReplayToken: attemptToken,
        resolvedAttemptContext,
      },
      retentionDays: 30,
      now: new Date("2026-10-29T00:01:00Z"),
    });

    const states = await pool.query<{ provider: string; status: string }>(
      `SELECT provider, status FROM public.oos_recovery_dependencies
       WHERE order_id = $1 ORDER BY provider`,
      [orderId]
    );
    expect(states.rows).toEqual([
      { provider: "d365", status: "resolved" },
      { provider: "gps", status: "parked" },
    ]);
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
