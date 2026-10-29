import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { claimPendingActionsSQL } from "@/lib/sql/pending-actions/claim";
import { completePendingActionSQL } from "@/lib/sql/pending-actions/finish";
import { importLegacyPendingActionsSQL } from "@/lib/sql/pending-actions/import-legacy";

const connectionString = process.env.PENDING_ACTIONS_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("pending lifecycle action PostgreSQL contract", () => {
  let pool: Pool;
  const orderPrefix = "pending-action-contract-";

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM public.pending_lifecycle_actions WHERE order_id LIKE $1", [
      `${orderPrefix}%`,
    ]);
    await pool.query("DELETE FROM public.orders WHERE id LIKE $1", [`${orderPrefix}%`]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertAction({
    orderId,
    actionType,
    status = "queued",
    attempts = 0,
    leaseToken = null,
    leaseExpiresAt = null,
  }: {
    orderId: string;
    actionType: "cancel" | "refund" | "fulfill";
    status?: "queued" | "publishing" | "dead_letter";
    attempts?: number;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | null;
  }) {
    const result = await pool.query<{ action_id: string }>(
      `INSERT INTO public.pending_lifecycle_actions (
         order_id, action_type, source_event_id, event_name, event_data,
         status, attempts, lease_token, lease_expires_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING action_id`,
      [
        orderId,
        actionType,
        randomUUID(),
        `test/${actionType}`,
        JSON.stringify({ orderId }),
        status,
        attempts,
        leaseToken,
        leaseExpiresAt,
      ]
    );
    return result.rows[0].action_id;
  }

  it("gives concurrent workers distinct claims", async () => {
    const firstId = await insertAction({
      orderId: `${orderPrefix}concurrent-1`,
      actionType: "refund",
    });
    const secondId = await insertAction({
      orderId: `${orderPrefix}concurrent-2`,
      actionType: "refund",
    });

    const [first, second] = await Promise.all([
      pool.query<{ action_id: string }>(claimPendingActionsSQL, [1, 120, 10]),
      pool.query<{ action_id: string }>(claimPendingActionsSQL, [1, 120, 10]),
    ]);
    const claimed = [...first.rows, ...second.rows].map((row) => row.action_id);

    expect(claimed).toHaveLength(2);
    expect(new Set(claimed)).toEqual(new Set([firstId, secondId]));
  });

  it("dead-letters repeatedly expired leases at the configured threshold", async () => {
    const orderId = `${orderPrefix}expired`;
    const actionId = await insertAction({
      orderId,
      actionType: "refund",
      status: "publishing",
      attempts: 1,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    const recovered = await pool.query<{ action_id: string }>(claimPendingActionsSQL, [10, 120, 2]);
    expect(recovered.rows).toHaveLength(0);
    await pool.query(
      "UPDATE public.pending_lifecycle_actions SET available_at = now() - interval '1 second' WHERE action_id = $1",
      [actionId]
    );

    const reclaimed = await pool.query<{ action_id: string }>(claimPendingActionsSQL, [10, 120, 2]);
    expect(reclaimed.rows.map((row) => row.action_id)).toContain(actionId);
    await pool.query(
      "UPDATE public.pending_lifecycle_actions SET lease_expires_at = now() - interval '1 second' WHERE action_id = $1",
      [actionId]
    );

    const terminal = await pool.query<{ action_id: string }>(claimPendingActionsSQL, [10, 120, 2]);
    expect(terminal.rows).toHaveLength(0);
    const state = await pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM public.pending_lifecycle_actions WHERE action_id = $1",
      [actionId]
    );
    expect(state.rows[0]).toMatchObject({ status: "dead_letter", attempts: 2 });
  });

  it("keeps dead-lettered cancellation ahead of fulfillment", async () => {
    const orderId = `${orderPrefix}cancelled`;
    const cancellationId = await insertAction({
      orderId,
      actionType: "cancel",
      status: "dead_letter",
      attempts: 10,
    });
    const fulfillmentId = await insertAction({ orderId, actionType: "fulfill" });
    const sources = await pool.query<{ action_type: string; source_event_id: string }>(
      `SELECT action_type, source_event_id
       FROM public.pending_lifecycle_actions
       WHERE action_id IN ($1, $2)`,
      [cancellationId, fulfillmentId]
    );
    const sourceByAction = new Map(
      sources.rows.map((row) => [row.action_type, row.source_event_id] as const)
    );
    await pool.query(
      `INSERT INTO public.orders (id, order_number, title, pending_actions)
       VALUES ($1, $1, $1, $2::jsonb)`,
      [
        orderId,
        JSON.stringify([
          {
            action: "cancel",
            eventName: "test/cancel",
            eventData: { orderId },
            sourceEventId: sourceByAction.get("cancel"),
          },
          {
            action: "fulfill",
            eventName: "test/fulfill",
            eventData: { orderId },
            sourceEventId: sourceByAction.get("fulfill"),
          },
        ]),
      ]
    );

    const result = await pool.query<{ action_id: string }>(claimPendingActionsSQL, [10, 120, 10]);
    expect(result.rows).toHaveLength(0);
    const state = await pool.query<{ status: string; event_data: Record<string, unknown> }>(
      "SELECT status, event_data FROM public.pending_lifecycle_actions WHERE action_id = $1",
      [fulfillmentId]
    );
    expect(state.rows[0]).toEqual({ status: "superseded", event_data: {} });
    const projection = await pool.query<{ pending_count: number; remaining_action: string }>(
      `SELECT
         jsonb_array_length(pending_actions) AS pending_count,
         pending_actions->0->>'action' AS remaining_action
       FROM public.orders
       WHERE id = $1`,
      [orderId]
    );
    expect(projection.rows[0]).toEqual({ pending_count: 1, remaining_action: "cancel" });
  });

  it("copies valid legacy actions without clearing them or letting poison rows block", async () => {
    const poisonId = `${orderPrefix}poison`;
    const validId = `${orderPrefix}legacy`;
    await pool.query(
      `INSERT INTO public.orders (id, order_number, title, pending_actions)
       VALUES
         ($1, $1, $1, '[{"eventName":"test/refund","eventData":{}}]'::jsonb),
         ($2, $2, $2, $3::jsonb)`,
      [
        poisonId,
        validId,
        JSON.stringify([
          {
            action: "refund",
            eventName: "test/refund",
            eventData: { orderId: validId },
            sourceEventId: "legacy-refund-1",
          },
          {
            action: "fulfill",
            eventName: "test/fulfill",
            eventData: { orderId: validId },
            sourceEventId: "legacy-fulfill-1",
          },
        ]),
      ]
    );

    const imported = await pool.query<{ imported: string; source_orders: string }>(
      importLegacyPendingActionsSQL,
      [10]
    );
    expect(imported.rows[0]).toEqual({ imported: "2", source_orders: "1" });

    const legacy = await pool.query<{ pending_count: number }>(
      "SELECT jsonb_array_length(pending_actions) AS pending_count FROM public.orders WHERE id = $1",
      [validId]
    );
    expect(legacy.rows[0].pending_count).toBe(2);

    const claimed = await pool.query<{
      action_id: string;
      action_type: string;
      order_id: string;
      lease_token: string;
    }>(claimPendingActionsSQL, [10, 120, 10]);
    const validClaim = claimed.rows.find(
      (row) => row.order_id === validId && row.action_type === "refund"
    );
    expect(validClaim).toBeDefined();
    await pool.query(completePendingActionSQL, [validClaim!.action_id, validClaim!.lease_token]);

    const completedProjection = await pool.query<{
      pending_count: number;
      remaining_action: string;
    }>(
      `SELECT
         jsonb_array_length(pending_actions) AS pending_count,
         pending_actions->0->>'action' AS remaining_action
       FROM public.orders
       WHERE id = $1`,
      [validId]
    );
    expect(completedProjection.rows[0]).toEqual({
      pending_count: 1,
      remaining_action: "fulfill",
    });
  });
});
