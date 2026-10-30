import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: getPool }));

import { acquireFulfillmentHousekeepingLockSQL } from "@/lib/sql/fulfillment-actions/housekeeping";
import {
  authorizeFulfillmentHousekeepingSuccessor,
  runFulfillmentActionHousekeeping,
  validateFulfillmentHousekeepingPolicy,
} from "@/lib/services/fulfillment-actions/housekeeping";
import { executeFulfillmentAction } from "@/lib/services/fulfillment-actions/ledger";
import type { ActionIdentity } from "@/lib/services/fulfillment-actions/identity";

const connectionString = process.env.FULFILLMENT_TEST_DATABASE_URL;
const scope = "housekeeping-integration";
const policy = {
  retentionDays: 90,
  batchSize: 100,
  unresolvedAlertHours: 24,
  alertRepeatHours: 24,
  alertBatchSize: 100,
};

describe.skipIf(!connectionString)("fulfillment-action housekeeping PostgreSQL contract", () => {
  let pool: Pool;
  const attemptIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  beforeEach(() => {
    getPool.mockReset();
    getPool.mockResolvedValue(pool);
  });

  afterEach(async () => {
    for (const attemptId of attemptIds) {
      await pool.query(
        "DELETE FROM public.slack_notification_outbox WHERE notification_id LIKE $1",
        [`${attemptId}:%`]
      );
    }
    await pool.query(
      "DELETE FROM public.fulfillment_evidence_claims WHERE attempt_id = ANY($1::uuid[])",
      [attemptIds]
    );
    await pool.query("DELETE FROM public.fulfillment_action_aliases WHERE scope=$1", [scope]);
    await pool.query("DELETE FROM public.fulfillment_actions WHERE scope=$1", [scope]);
    await pool.query("DELETE FROM public.fulfillment_action_tombstones WHERE scope=$1", [scope]);
    await pool.query("DELETE FROM public.fulfillment_action_housekeeping_quarantine");
    await pool.query("DELETE FROM public.fulfillment_housekeeping_run_receipts");
    await pool.query("DELETE FROM public.fulfillment_housekeeping_successor");
    await pool.query(
      "DELETE FROM public.slack_notification_outbox WHERE notification_id LIKE '%:fulfillment-action-housekeeping-quarantine'"
    );
    attemptIds.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertAction(input: {
    key: string;
    attemptId?: string;
    provider?: "gps" | "dynamics";
    status: "pending" | "succeeded" | "failed" | "uncertain";
    ageDays: number;
    actionName?: string;
    lineId?: string;
    result?: unknown;
  }) {
    const attemptId = input.attemptId ?? randomUUID();
    if (!attemptIds.includes(attemptId)) attemptIds.push(attemptId);
    await pool.query(
      `INSERT INTO public.fulfillment_actions (
         action_key, provider, scope, source_order_id, source_line_id, action_name,
         request_hash, attempt_id, status, result, error_code,
         created_at, updated_at, unresolved_since
       ) VALUES (
         $1, $11, $2, $3, $4, $5,
         repeat('a', 64), $6, $7, $8::jsonb, $9,
         now() - make_interval(days => $10),
         now() - make_interval(days => $10),
         CASE WHEN $7 IN ('pending', 'uncertain')
           THEN now() - make_interval(days => $10) ELSE NULL END
       )`,
      [
        input.key,
        scope,
        `ORDER-${input.key}`,
        input.lineId ?? `LINE-${input.key}`,
        input.actionName ?? "create_outbound_order",
        attemptId,
        input.status,
        input.status === "succeeded"
          ? JSON.stringify(input.result ?? { orderNo: input.key, logisticsChannel: "standard" })
          : null,
        input.status === "uncertain" ? "provider_outcome_unknown" : null,
        input.ageDays,
        input.provider ?? "gps",
      ]
    );
    return attemptId;
  }

  it("deletes terminal rows in bounded batches while retaining replay relationships", async () => {
    const oldestAttempt = await insertAction({ key: "oldest", status: "succeeded", ageDays: 100 });
    const olderAttempt = await insertAction({ key: "older", status: "failed", ageDays: 95 });
    await insertAction({ key: "recent", status: "succeeded", ageDays: 10 });

    for (const key of ["oldest", "older", "recent"]) {
      await pool.query(
        `INSERT INTO public.fulfillment_action_aliases
           (provider, scope, source_order_id, alias_name, action_name)
         VALUES ('gps', $1, $2, $3, $4)`,
        [scope, `ORDER-${key}`, `alias:${key}`, "create_outbound_order"]
      );
    }
    for (const [attemptId, documentId] of [
      [oldestAttempt, "DOC-OLDEST"],
      [olderAttempt, "DOC-OLDER"],
    ]) {
      await pool.query(
        `INSERT INTO public.fulfillment_evidence_claims
           (provider, scope, document_id, attempt_id, evidence)
         VALUES ('gps', $1, $2, $3, '{}'::jsonb)`,
        [scope, documentId, attemptId]
      );
    }

    const first = await runFulfillmentActionHousekeeping({ ...policy, batchSize: 1 });
    expect(first).toMatchObject({
      skipped: false,
      deleted: 1,
      aliasesDeleted: 0,
      evidenceDeleted: 0,
      hasMore: true,
    });
    expect(
      (
        await pool.query("SELECT action_key FROM public.fulfillment_actions WHERE scope=$1", [
          scope,
        ])
      ).rows
    ).toHaveLength(2);

    const second = await runFulfillmentActionHousekeeping({ ...policy, batchSize: 1 });
    expect(second).toMatchObject({
      deleted: 1,
      aliasesDeleted: 0,
      evidenceDeleted: 0,
      hasMore: false,
    });
    expect(
      await pool.query("SELECT action_key FROM public.fulfillment_actions WHERE scope=$1", [scope])
    ).toMatchObject({ rows: [{ action_key: "recent" }] });
    expect(
      await pool.query(
        "SELECT action_key FROM public.fulfillment_action_tombstones WHERE scope=$1",
        [scope]
      )
    ).toMatchObject({ rows: [{ action_key: "oldest" }] });
    expect(
      (
        await pool.query(
          "SELECT alias_name FROM public.fulfillment_action_aliases WHERE scope=$1",
          [scope]
        )
      ).rows
    ).toHaveLength(3);
    expect(
      (
        await pool.query(
          "SELECT document_id FROM public.fulfillment_evidence_claims WHERE scope=$1",
          [scope]
        )
      ).rows
    ).toHaveLength(2);
  });

  it("replays a successful provider result after the active row ages out", async () => {
    const identity: ActionIdentity = {
      provider: "gps",
      scope,
      sourceOrderId: "ORDER-REPLAY",
      sourceLineIds: ["LINE-REPLAY"],
      action: "create_outbound_order",
    };
    const request = { sku: "SKU-1", quantity: 1 };
    const execute = vi.fn(async () => ({ orderNo: "GPS-REPLAY", logisticsChannel: "standard" }));

    await expect(executeFulfillmentAction(identity, request, execute)).resolves.toEqual({
      orderNo: "GPS-REPLAY",
      logisticsChannel: "standard",
    });
    await pool.query(
      "UPDATE public.fulfillment_actions SET updated_at=now()-interval '91 days' WHERE scope=$1",
      [scope]
    );

    await expect(runFulfillmentActionHousekeeping(policy)).resolves.toMatchObject({ deleted: 1 });
    expect(
      await pool.query("SELECT action_key FROM public.fulfillment_actions WHERE scope=$1", [scope])
    ).toMatchObject({ rows: [] });
    expect(
      await pool.query(
        "SELECT action_key FROM public.fulfillment_action_tombstones WHERE scope=$1",
        [scope]
      )
    ).toMatchObject({ rows: [expect.any(Object)] });

    await expect(executeFulfillmentAction(identity, request, execute)).resolves.toEqual({
      orderNo: "GPS-REPLAY",
      logisticsChannel: "standard",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("archives only the bounded per-operation replay result", async () => {
    await insertAction({ key: "minimal", status: "succeeded", ageDays: 91 });
    await pool.query(
      `UPDATE public.fulfillment_actions
       SET result = result || '{"customerAddress":"must-not-survive"}'::jsonb
       WHERE scope=$1 AND action_key='minimal'`,
      [scope]
    );

    await expect(runFulfillmentActionHousekeeping(policy)).resolves.toMatchObject({ deleted: 1 });
    const archived = await pool.query<{ result: Record<string, unknown>; bytes: number }>(
      `SELECT result, octet_length(result::text) AS bytes
       FROM public.fulfillment_action_tombstones
       WHERE scope=$1 AND action_key='minimal'`,
      [scope]
    );
    expect(archived.rows).toEqual([
      {
        result: { orderNo: "minimal", logisticsChannel: "standard" },
        bytes: expect.any(Number),
      },
    ]);
    expect(archived.rows[0].bytes).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(archived.rows[0].result)).not.toContain("must-not-survive");
  });

  it("defines bounded replay codecs for every current fulfillment operation", async () => {
    const cases = [
      ["gps", "create_outbound_order", { orderNo: "GPS-1", logisticsChannel: "standard" }],
      ["gps", "cancel:0", { cancelled: true }],
      ["shopify", "split:0", { selectedId: "1", remainderId: "2" }],
      ["dynamics", "shipment:1", { status: 1, Message: "provider detail" }],
      ["dynamics", "segment-0:header", "SO-1"],
      ["dynamics", "segment-0:line:1:SKU", "LOT-1"],
      ["dynamics", "segment-0:confirm", { confirmed: true }],
      ["dynamics", "segment-0:prepayment", { posted: true }],
      [
        "dynamics",
        "oos-recovery-line:SO-1",
        { InventoryLotId: "LOT-1", request: { giftCardNumber: "discard" } },
      ],
      [
        "dynamics",
        "oos-recovery-confirm",
        { response: { status: 1 }, request: { salesOrderNumber: "discard" } },
      ],
      [
        "dynamics",
        "oos-recovery-prepayment",
        { response: { status: 1 }, request: { salesOrderNumber: "discard" } },
      ],
      [
        "dynamics",
        "refund:1:invoice",
        { creditNoteNumber: "CN-1", success: true, skipped: false, extra: "discard" },
      ],
    ] as const;

    for (const [provider, action, result] of cases) {
      const minimized = await pool.query<{ result: unknown; bytes: number }>(
        `SELECT public.minimize_fulfillment_action_replay_result($1, $2, $3::jsonb) AS result,
                octet_length(
                  public.minimize_fulfillment_action_replay_result($1, $2, $3::jsonb)::text
                ) AS bytes`,
        [provider, action, JSON.stringify(result)]
      );
      expect(minimized.rows[0].bytes).toBeLessThanOrEqual(2048);
      expect(JSON.stringify(minimized.rows[0].result)).not.toMatch(
        /giftCardNumber|salesOrderNumber|provider detail|extra/i
      );
    }

    for (const [provider, action] of cases) {
      await expect(
        pool.query("SELECT public.minimize_fulfillment_action_replay_result($1, $2, '{}'::jsonb)", [
          provider,
          action,
        ])
      ).rejects.toThrow(/Invalid/);
    }

    await expect(
      pool.query(
        "SELECT public.minimize_fulfillment_action_replay_result('gps', 'unknown', '{}'::jsonb)"
      )
    ).rejects.toThrow("No permanent replay codec");
  });

  it("gives two distinct roots only one durable successor publication", async () => {
    await insertAction({ key: "root-a", status: "failed", ageDays: 94 });
    await insertAction({ key: "root-b", status: "failed", ageDays: 93 });
    await insertAction({ key: "root-c", status: "failed", ageDays: 92 });

    const first = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      { rootRunId: "root-a", batch: 0, successorDelayMinutes: 1 }
    );
    const second = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      { rootRunId: "root-b", batch: 0, successorDelayMinutes: 1 }
    );

    expect(first).toMatchObject({ hasMore: true, successor: { rootRunId: "root-a", batch: 1 } });
    expect(second).toMatchObject({ hasMore: true, successor: null });
    expect(
      await pool.query(
        "SELECT claim_id, root_run_id, batch FROM public.fulfillment_housekeeping_successor"
      )
    ).toMatchObject({
      rows: [{ claim_id: first.successor?.claimId, root_run_id: "root-a", batch: 1 }],
    });

    await pool.query(
      `UPDATE public.fulfillment_housekeeping_successor
       SET publish_after=clock_timestamp()-interval '1 second'`
    );
    await expect(authorizeFulfillmentHousekeepingSuccessor(first.successor!.claimId)).resolves.toBe(
      true
    );
    await expect(authorizeFulfillmentHousekeepingSuccessor(first.successor!.claimId)).resolves.toBe(
      true
    );
  });

  it("replays a committed successor receipt after an ambiguous step checkpoint", async () => {
    for (const [key, ageDays] of [
      ["receipt-a", 96],
      ["receipt-b", 95],
      ["receipt-c", 94],
      ["receipt-d", 93],
    ] as const) {
      await insertAction({ key, status: "failed", ageDays });
    }

    const root = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      { rootRunId: "receipt-root", batch: 0, successorDelayMinutes: 1 }
    );
    const firstClaimId = root.successor?.claimId;
    expect(firstClaimId).toBeTruthy();
    await pool.query(
      `UPDATE public.fulfillment_housekeeping_successor
       SET publish_after=clock_timestamp()-interval '1 second'`
    );
    await expect(authorizeFulfillmentHousekeepingSuccessor(firstClaimId!)).resolves.toBe(true);

    const continuation = {
      rootRunId: "receipt-root",
      batch: 1,
      successorDelayMinutes: 1,
      incomingClaimId: firstClaimId!,
    };
    const committed = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      continuation
    );
    const replayed = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      continuation
    );

    expect(committed).toMatchObject({ deleted: 1, hasMore: true, successor: expect.any(Object) });
    expect(replayed).toEqual(committed);
    expect(
      (
        await pool.query(
          "SELECT action_key FROM public.fulfillment_actions WHERE scope=$1 AND status='failed'",
          [scope]
        )
      ).rows
    ).toHaveLength(2);
  });

  it("replays a committed receipt while another housekeeping run holds the lock", async () => {
    for (const [key, ageDays] of [
      ["contended-receipt-a", 96],
      ["contended-receipt-b", 95],
    ] as const) {
      await insertAction({ key, status: "failed", ageDays });
    }

    const continuation = {
      rootRunId: "contended-receipt-root",
      batch: 0,
      successorDelayMinutes: 1,
    };
    const committed = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      continuation
    );

    const lockHolder = await pool.connect();
    try {
      await lockHolder.query("BEGIN");
      const held = await lockHolder.query<{ acquired: boolean }>(
        acquireFulfillmentHousekeepingLockSQL
      );
      expect(held.rows[0]?.acquired).toBe(true);

      const replayed = await runFulfillmentActionHousekeeping(
        { ...policy, batchSize: 1 },
        continuation
      );
      expect(replayed).toEqual(committed);
      expect(replayed.skipped).toBe(false);
    } finally {
      await lockHolder.query("ROLLBACK");
      lockHolder.release();
    }
  });

  it("recovers an expired unpublished successor without authorizing the stale claim", async () => {
    for (const [key, ageDays] of [
      ["recover-a", 95],
      ["recover-b", 94],
      ["recover-c", 93],
    ] as const) {
      await insertAction({ key, status: "failed", ageDays });
    }

    const first = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      { rootRunId: "expired-root", batch: 0, successorDelayMinutes: 1 }
    );
    const staleClaimId = first.successor?.claimId;
    expect(staleClaimId).toBeTruthy();
    await pool.query(
      `UPDATE public.fulfillment_housekeeping_successor
       SET publish_after=clock_timestamp()-interval '2 seconds',
           claim_expires_at=clock_timestamp()-interval '1 second'`
    );

    const recovered = await runFulfillmentActionHousekeeping(
      { ...policy, batchSize: 1 },
      { rootRunId: "recovery-root", batch: 0, successorDelayMinutes: 1 }
    );
    expect(recovered).toMatchObject({
      hasMore: true,
      successor: { rootRunId: "recovery-root", batch: 1 },
    });
    expect(recovered.successor?.claimId).not.toBe(staleClaimId);
    await pool.query(
      `UPDATE public.fulfillment_housekeeping_successor
       SET publish_after=clock_timestamp()-interval '1 second'`
    );
    await expect(authorizeFulfillmentHousekeepingSuccessor(staleClaimId!)).resolves.toBe(false);
    await expect(
      authorizeFulfillmentHousekeepingSuccessor(recovered.successor!.claimId)
    ).resolves.toBe(true);
  });

  it("quarantines an unsupported success without blocking deletion or unresolved alerts", async () => {
    await insertAction({
      key: "unsupported",
      status: "succeeded",
      ageDays: 100,
      actionName: "unsupported_operation",
    });
    await insertAction({ key: "deletable", status: "failed", ageDays: 95 });
    await insertAction({
      key: "needs-review",
      status: "uncertain",
      ageDays: 2,
      actionName: "shipment:needs-review",
    });

    const first = await runFulfillmentActionHousekeeping({ ...policy, batchSize: 1 });
    expect(first).toMatchObject({
      deleted: 0,
      quarantined: 1,
      alertsEnqueued: 2,
      hasMore: true,
    });
    expect(
      await pool.query(
        "SELECT action_key, reason_code FROM public.fulfillment_action_housekeeping_quarantine"
      )
    ).toMatchObject({
      rows: [{ action_key: "unsupported", reason_code: "unsupported_replay_result" }],
    });
    const quarantineAlert = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM public.slack_notification_outbox
       WHERE notification_id='unsupported:fulfillment-action-housekeeping-quarantine'`
    );
    expect(quarantineAlert.rows).toHaveLength(1);
    expect(JSON.stringify(quarantineAlert.rows[0].payload)).not.toMatch(
      /address|request_hash|recovery_context/i
    );

    const second = await runFulfillmentActionHousekeeping({ ...policy, batchSize: 1 });
    expect(second).toMatchObject({ deleted: 1, quarantined: 0, hasMore: false });
    expect(
      await pool.query(
        "SELECT action_key FROM public.fulfillment_actions WHERE scope=$1 ORDER BY action_key",
        [scope]
      )
    ).toMatchObject({ rows: [{ action_key: "needs-review" }, { action_key: "unsupported" }] });
  });

  it("quarantines a minimized replay result that exceeds the byte limit", async () => {
    await insertAction({
      key: "oversized-multibyte",
      provider: "dynamics",
      status: "succeeded",
      ageDays: 100,
      actionName: "segment-1:header",
      result: "😀".repeat(512),
    });

    await expect(runFulfillmentActionHousekeeping(policy)).resolves.toMatchObject({
      deleted: 0,
      quarantined: 1,
      hasMore: false,
    });
    await expect(
      pool.query(
        `SELECT reason_code FROM public.fulfillment_action_housekeeping_quarantine
         WHERE action_key='oversized-multibyte'`
      )
    ).resolves.toMatchObject({ rows: [{ reason_code: "unsupported_replay_result" }] });
  });

  it("retains unresolved attempts and enqueues one safe alert per attempt and day", async () => {
    const attemptId = randomUUID();
    await insertAction({
      key: "uncertain-a",
      attemptId,
      status: "uncertain",
      ageDays: 365,
      actionName: "shipment:uncertain",
      lineId: "LINE-A",
    });
    await insertAction({
      key: "uncertain-b",
      attemptId,
      status: "uncertain",
      ageDays: 365,
      actionName: "shipment:uncertain",
      lineId: "LINE-B",
    });

    const first = await runFulfillmentActionHousekeeping(policy);
    expect(first).toMatchObject({ deleted: 0, alertsEnqueued: 1, hasMore: false });

    const actions = await pool.query<{
      unresolved_since: Date;
      last_unresolved_alert_at: Date | null;
    }>(
      `SELECT unresolved_since, last_unresolved_alert_at
       FROM public.fulfillment_actions WHERE attempt_id=$1 ORDER BY action_key`,
      [attemptId]
    );
    expect(actions.rows).toHaveLength(2);
    expect(actions.rows.every((row) => row.last_unresolved_alert_at)).toBe(true);
    expect(
      actions.rows.every(
        (row) => Date.now() - row.unresolved_since.getTime() > 364 * 24 * 60 * 60 * 1000
      )
    ).toBe(true);

    const outbox = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM public.slack_notification_outbox WHERE notification_id LIKE $1",
      [`${attemptId}:%`]
    );
    expect(outbox.rows).toHaveLength(1);
    expect(JSON.stringify(outbox.rows[0].payload)).not.toMatch(
      /address|request_hash|recovery_context/i
    );

    const repeat = await runFulfillmentActionHousekeeping(policy);
    expect(repeat).toMatchObject({ deleted: 0, alertsEnqueued: 0, hasMore: false });
    expect(
      await pool.query(
        "SELECT action_key FROM public.fulfillment_actions WHERE attempt_id=$1 ORDER BY action_key",
        [attemptId]
      )
    ).toMatchObject({ rows: [{ action_key: "uncertain-a" }, { action_key: "uncertain-b" }] });
  });

  it("skips a concurrent run while the database single-flight lock is held", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      expect((await lockClient.query(acquireFulfillmentHousekeepingLockSQL)).rows[0].acquired).toBe(
        true
      );
      await expect(runFulfillmentActionHousekeeping(policy)).resolves.toMatchObject({
        skipped: true,
        deleted: 0,
        alertsEnqueued: 0,
        hasMore: false,
      });
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("rejects unsafe retention and unbounded batch settings", () => {
    expect(() => validateFulfillmentHousekeepingPolicy({ ...policy, retentionDays: 89 })).toThrow(
      "retentionDays"
    );
    expect(() => validateFulfillmentHousekeepingPolicy({ ...policy, batchSize: 101 })).toThrow(
      "batchSize"
    );
    expect(() =>
      validateFulfillmentHousekeepingPolicy({ ...policy, unresolvedAlertHours: 23 })
    ).toThrow("unresolvedAlertHours");
  });

  it("rejects null bounds at the privileged database boundary", async () => {
    await expect(
      pool.query("SELECT * FROM public.delete_retained_fulfillment_actions(90, NULL)")
    ).rejects.toThrow("batch_size must be between 1 and 100");
    await expect(
      pool.query("SELECT * FROM public.delete_retained_fulfillment_actions(NULL, 100)")
    ).rejects.toThrow("retention_days must be between 90 and 3650");
  });
});
