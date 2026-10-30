import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/database", () => ({ getDatabasePool: getPool }));

import { acquireFulfillmentHousekeepingLockSQL } from "@/lib/sql/fulfillment-actions/housekeeping";
import {
  runFulfillmentActionHousekeeping,
  validateFulfillmentHousekeepingPolicy,
} from "@/lib/services/fulfillment-actions/housekeeping";

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
    attemptIds.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertAction(input: {
    key: string;
    attemptId?: string;
    status: "pending" | "succeeded" | "failed" | "uncertain";
    ageDays: number;
    actionName?: string;
    lineId?: string;
  }) {
    const attemptId = input.attemptId ?? randomUUID();
    if (!attemptIds.includes(attemptId)) attemptIds.push(attemptId);
    await pool.query(
      `INSERT INTO public.fulfillment_actions (
         action_key, provider, scope, source_order_id, source_line_id, action_name,
         request_hash, attempt_id, status, result, error_code,
         created_at, updated_at, unresolved_since
       ) VALUES (
         $1, 'gps', $2, $3, $4, $5,
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
        input.actionName ?? `shipment:${input.key}`,
        attemptId,
        input.status,
        input.status === "succeeded" ? JSON.stringify({ providerReference: input.key }) : null,
        input.status === "uncertain" ? "provider_outcome_unknown" : null,
        input.ageDays,
      ]
    );
    return attemptId;
  }

  it("deletes terminal actions in bounded batches with orphaned aliases and evidence", async () => {
    const oldestAttempt = await insertAction({ key: "oldest", status: "succeeded", ageDays: 100 });
    const olderAttempt = await insertAction({ key: "older", status: "failed", ageDays: 95 });
    await insertAction({ key: "recent", status: "succeeded", ageDays: 10 });

    for (const actionName of ["shipment:oldest", "shipment:older", "shipment:recent"]) {
      await pool.query(
        `INSERT INTO public.fulfillment_action_aliases
           (provider, scope, source_order_id, alias_name, action_name)
         VALUES ('gps', $1, $2, $3, $4)`,
        [scope, `ORDER-${actionName.slice(9)}`, `alias:${actionName}`, actionName]
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
      aliasesDeleted: 1,
      evidenceDeleted: 1,
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
      aliasesDeleted: 1,
      evidenceDeleted: 1,
      hasMore: false,
    });
    expect(
      await pool.query("SELECT action_key FROM public.fulfillment_actions WHERE scope=$1", [scope])
    ).toMatchObject({ rows: [{ action_key: "recent" }] });
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
        hasMore: true,
      });
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("rejects unsafe retention and unbounded batch settings", () => {
    expect(() => validateFulfillmentHousekeepingPolicy({ ...policy, retentionDays: 29 })).toThrow(
      "retentionDays"
    );
    expect(() => validateFulfillmentHousekeepingPolicy({ ...policy, batchSize: 101 })).toThrow(
      "batchSize"
    );
    expect(() =>
      validateFulfillmentHousekeepingPolicy({ ...policy, unresolvedAlertHours: 23 })
    ).toThrow("unresolvedAlertHours");
  });
});
