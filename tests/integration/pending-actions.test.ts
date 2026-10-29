import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { claimPendingActionsSQL } from "@/lib/sql/pending-actions/claim";
import { enqueuePendingActionSQL } from "@/lib/sql/pending-actions/enqueue";
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
    await pool.query(
      `DELETE FROM public.pending_lifecycle_action_resolutions
       WHERE action_id IN (
         SELECT action_id
         FROM public.pending_lifecycle_actions
         WHERE order_id LIKE $1
       )`,
      [`${orderPrefix}%`]
    );
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
    const oversizedId = `${orderPrefix}oversized`;
    const validId = `${orderPrefix}legacy`;
    const existingActionId = await insertAction({
      orderId: `${orderPrefix}existing-normalized`,
      actionType: "refund",
    });
    await pool.query(
      `INSERT INTO public.orders (id, order_number, title, pending_actions)
       VALUES
         ($1, $1, $1, '[{"eventName":"test/refund","eventData":{}}]'::jsonb),
         ($2, $2, $2, $3::jsonb),
         ($4, $4, $4, $5::jsonb)`,
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
        oversizedId,
        JSON.stringify([
          {
            action: "refund",
            eventName: "test/refund",
            eventData: { payload: "x".repeat(524_289) },
            sourceEventId: "legacy-oversized-1",
          },
        ]),
      ]
    );

    const imported = await pool.query<{
      imported: string;
      source_orders: string;
      poison_orders: string;
    }>(importLegacyPendingActionsSQL, [10]);
    expect(imported.rows[0]).toEqual({
      imported: "2",
      source_orders: "1",
      poison_orders: "2",
    });

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
    expect(claimed.rows.map((row) => row.action_id)).toContain(existingActionId);
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

  it("does not recreate a legacy projection when a terminal action is retried", async () => {
    const orderId = `${orderPrefix}terminal-retry`;
    const sourceEventId = "terminal-retry-source";
    const eventData = { shopifyOrderId: orderId };
    const legacyPayload = {
      action: "refund",
      eventName: "test/refund",
      eventData,
      sourceEventId,
    };
    await pool.query(
      `INSERT INTO public.orders (
         id, order_number, title, shopify_order_id, pending_actions
       ) VALUES ($1, $1, $1, $1, '[]'::jsonb)`,
      [orderId]
    );

    const first = await pool.query<{ action_id: string; legacy_projected: boolean }>(
      enqueuePendingActionSQL,
      [
        orderId,
        "refund",
        sourceEventId,
        "test/refund",
        JSON.stringify(eventData),
        JSON.stringify(legacyPayload),
        true,
      ]
    );
    expect(first.rows[0].legacy_projected).toBe(true);

    const claimed = await pool.query<{ action_id: string; lease_token: string }>(
      claimPendingActionsSQL,
      [10, 120, 10]
    );
    const action = claimed.rows.find((row) => row.action_id === first.rows[0].action_id);
    expect(action).toBeDefined();
    await pool.query(completePendingActionSQL, [action!.action_id, action!.lease_token]);

    const retry = await pool.query<{ action_id: string; legacy_projected: boolean }>(
      enqueuePendingActionSQL,
      [
        orderId,
        "refund",
        sourceEventId,
        "test/refund",
        JSON.stringify(eventData),
        JSON.stringify(legacyPayload),
        true,
      ]
    );
    expect(retry.rows[0]).toEqual({
      action_id: first.rows[0].action_id,
      legacy_projected: false,
    });

    const projection = await pool.query<{ pending_count: number }>(
      `SELECT jsonb_array_length(pending_actions) AS pending_count
       FROM public.orders WHERE id = $1`,
      [orderId]
    );
    expect(projection.rows[0].pending_count).toBe(0);
  });

  it("blocks legacy rollback until an audited dead-letter replay settles", async () => {
    const actionId = await insertAction({
      orderId: `${orderPrefix}rollback-gate`,
      actionType: "refund",
      status: "dead_letter",
      attempts: 10,
    });

    const beforeReplay = await pool.query<{
      dead_letter_actions: string;
      safe_to_resume_legacy: boolean;
    }>("SELECT * FROM public.pending_lifecycle_action_rollback_status()");
    expect(beforeReplay.rows[0]).toMatchObject({
      dead_letter_actions: "1",
      safe_to_resume_legacy: false,
    });

    await pool.query("SELECT public.requeue_pending_lifecycle_action($1, $2)", [
      actionId,
      "INC-rollback: verified provider outcome",
    ]);

    const beforeSettlement = await pool.query<{
      uncertain_queued_actions: string;
      safe_to_resume_legacy: boolean;
    }>("SELECT * FROM public.pending_lifecycle_action_rollback_status()");
    expect(beforeSettlement.rows[0]).toMatchObject({
      uncertain_queued_actions: "1",
      safe_to_resume_legacy: false,
    });

    await pool.query(
      `UPDATE public.pending_lifecycle_actions
       SET status = 'publishing',
           attempts = attempts + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + interval '2 minutes'
       WHERE action_id = $1`,
      [actionId]
    );
    await pool.query(
      `UPDATE public.pending_lifecycle_actions
       SET status = 'published',
           published_at = now(),
           lease_token = NULL,
           lease_expires_at = NULL
       WHERE action_id = $1`,
      [actionId]
    );

    const afterSettlement = await pool.query<{ safe_to_resume_legacy: boolean }>(
      "SELECT * FROM public.pending_lifecycle_action_rollback_status()"
    );
    expect(afterSettlement.rows[0].safe_to_resume_legacy).toBe(true);
  });

  it("fails rollback closed on missing and stale legacy projections", async () => {
    const queuedOrderId = `${orderPrefix}missing-projection`;
    const queuedActionId = await insertAction({
      orderId: queuedOrderId,
      actionType: "refund",
    });
    const queuedSource = await pool.query<{ source_event_id: string }>(
      "SELECT source_event_id FROM public.pending_lifecycle_actions WHERE action_id = $1",
      [queuedActionId]
    );

    const missing = await pool.query<{
      missing_queued_projections: string;
      safe_to_resume_legacy: boolean;
    }>("SELECT * FROM public.pending_lifecycle_action_rollback_status()");
    expect(missing.rows[0]).toMatchObject({
      missing_queued_projections: "1",
      safe_to_resume_legacy: false,
    });

    await pool.query(
      `INSERT INTO public.orders (id, order_number, title, pending_actions)
       VALUES ($1, $1, $1, $2::jsonb)`,
      [
        queuedOrderId,
        JSON.stringify([
          {
            action: "refund",
            eventName: "test/refund",
            eventData: { orderId: queuedOrderId },
            sourceEventId: queuedSource.rows[0].source_event_id,
          },
        ]),
      ]
    );

    const consistent = await pool.query<{ safe_to_resume_legacy: boolean }>(
      "SELECT * FROM public.pending_lifecycle_action_rollback_status()"
    );
    expect(consistent.rows[0].safe_to_resume_legacy).toBe(true);

    const terminalOrderId = `${orderPrefix}stale-projection`;
    const terminalSourceId = "terminal-stale-source";
    await pool.query(
      `INSERT INTO public.pending_lifecycle_actions (
         order_id, action_type, source_event_id, event_name, event_data,
         status, published_at
       ) VALUES ($1, 'refund', $2, 'test/refund', '{}'::jsonb, 'published', now())`,
      [terminalOrderId, terminalSourceId]
    );
    await pool.query(
      `INSERT INTO public.orders (id, order_number, title, pending_actions)
       VALUES ($1, $1, $1, $2::jsonb)`,
      [
        terminalOrderId,
        JSON.stringify([
          {
            action: "refund",
            eventName: "test/refund",
            eventData: { orderId: terminalOrderId },
            sourceEventId: terminalSourceId,
          },
        ]),
      ]
    );

    const stale = await pool.query<{
      stale_terminal_projections: string;
      safe_to_resume_legacy: boolean;
    }>("SELECT * FROM public.pending_lifecycle_action_rollback_status()");
    expect(stale.rows[0]).toMatchObject({
      stale_terminal_projections: "1",
      safe_to_resume_legacy: false,
    });

    await pool.query("UPDATE public.orders SET pending_actions = '[]'::jsonb WHERE id = $1", [
      terminalOrderId,
    ]);
    const repaired = await pool.query<{ safe_to_resume_legacy: boolean }>(
      "SELECT * FROM public.pending_lifecycle_action_rollback_status()"
    );
    expect(repaired.rows[0].safe_to_resume_legacy).toBe(true);
  });
});
