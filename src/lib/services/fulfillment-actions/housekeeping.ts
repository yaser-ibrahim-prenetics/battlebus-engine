import type { PoolClient } from "pg";

import { getDatabasePool } from "@/lib/db/database";
import type { SlackNotification } from "@/lib/clients/slack";
import { slackNotificationId } from "@/lib/clients/slack";
import { enqueueNotificationSQL } from "@/lib/sql/slack-notifications/enqueue";
import {
  acquireFulfillmentHousekeepingLockSQL,
  deleteRetainedTerminalActionsSQL,
  fulfillmentHousekeepingHasMoreSQL,
  markFulfillmentAttemptAlertedSQL,
  selectDueUnresolvedFulfillmentAlertsSQL,
} from "@/lib/sql/fulfillment-actions/housekeeping";

const MIN_RETENTION_DAYS = 30;
const MAX_BATCH_SIZE = 100;
const MIN_ALERT_HOURS = 24;

export interface FulfillmentHousekeepingPolicy {
  retentionDays: number;
  batchSize: number;
  unresolvedAlertHours: number;
  alertRepeatHours: number;
  alertBatchSize: number;
}

export interface FulfillmentHousekeepingResult {
  skipped: boolean;
  deleted: number;
  aliasesDeleted: number;
  evidenceDeleted: number;
  alertsEnqueued: number;
  hasMore: boolean;
}

interface DueAlert {
  action_key: string;
  attempt_id: string;
  provider: "dynamics" | "gps" | "shopify";
  source_order_id: string;
  action_name: string;
  status: "pending" | "uncertain";
  error_code: string | null;
  unresolved_since: Date;
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

export function validateFulfillmentHousekeepingPolicy(policy: FulfillmentHousekeepingPolicy) {
  assertIntegerInRange("retentionDays", policy.retentionDays, MIN_RETENTION_DAYS, 3650);
  assertIntegerInRange("batchSize", policy.batchSize, 1, MAX_BATCH_SIZE);
  assertIntegerInRange("unresolvedAlertHours", policy.unresolvedAlertHours, MIN_ALERT_HOURS, 8760);
  assertIntegerInRange("alertRepeatHours", policy.alertRepeatHours, MIN_ALERT_HOURS, 8760);
  assertIntegerInRange("alertBatchSize", policy.alertBatchSize, 1, MAX_BATCH_SIZE);
}

function alertChannel(provider: DueAlert["provider"]): SlackNotification["channel"] {
  if (provider === "dynamics") return "dynamics";
  if (provider === "shopify") return "shopify";
  return "gps";
}

export function buildUnresolvedFulfillmentNotification(
  alert: DueAlert,
  alertedAt: Date
): SlackNotification {
  const ageHours = Math.max(
    0,
    Math.floor((alertedAt.getTime() - alert.unresolved_since.getTime()) / (60 * 60 * 1000))
  );
  return {
    id: slackNotificationId(
      alert.attempt_id,
      "fulfillment-action-unresolved",
      alertedAt.toISOString().slice(0, 10)
    ),
    channel: alertChannel(alert.provider),
    severity: "critical",
    title: "Fulfillment action requires reconciliation",
    summary: "A fulfillment provider outcome remains unresolved and requires operator review.",
    fields: [
      { label: "Action ID", value: alert.attempt_id },
      { label: "Operation", value: alert.action_name },
      { label: "Provider", value: alert.provider },
      { label: "Order reference", value: alert.source_order_id },
      { label: "Age", value: `${ageHours}h` },
      { label: "Error category", value: alert.error_code ?? `${alert.status}_outcome` },
    ],
    occurredAt: alertedAt.toISOString(),
  };
}

async function deleteExpiredTerminalActions(
  client: PoolClient,
  policy: FulfillmentHousekeepingPolicy
) {
  const cleanup = await client.query<{
    deleted: number;
    aliases_deleted: number;
    evidence_deleted: number;
  }>(deleteRetainedTerminalActionsSQL, [policy.retentionDays, policy.batchSize]);
  const result = cleanup.rows[0];
  return {
    deleted: result?.deleted ?? 0,
    aliasesDeleted: result?.aliases_deleted ?? 0,
    evidenceDeleted: result?.evidence_deleted ?? 0,
  };
}

async function enqueueDueAlerts(
  client: PoolClient,
  startedAt: Date,
  policy: FulfillmentHousekeepingPolicy
): Promise<number> {
  const due = await client.query<DueAlert>(selectDueUnresolvedFulfillmentAlertsSQL, [
    startedAt,
    policy.unresolvedAlertHours,
    policy.alertRepeatHours,
    policy.alertBatchSize,
  ]);
  let enqueued = 0;
  for (const alert of due.rows) {
    const marked = await client.query(markFulfillmentAttemptAlertedSQL, [
      alert.attempt_id,
      startedAt,
      policy.unresolvedAlertHours,
      policy.alertRepeatHours,
    ]);
    if (!marked.rowCount) continue;
    const notification = buildUnresolvedFulfillmentNotification(alert, startedAt);
    const inserted = await client.query(enqueueNotificationSQL, [
      notification.id,
      JSON.stringify(notification),
    ]);
    enqueued += inserted.rowCount ?? 0;
  }
  return enqueued;
}

export async function runFulfillmentActionHousekeeping(
  policy: FulfillmentHousekeepingPolicy
): Promise<FulfillmentHousekeepingResult> {
  validateFulfillmentHousekeepingPolicy(policy);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Fulfillment housekeeping database unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ acquired: boolean; started_at: Date }>(
      acquireFulfillmentHousekeepingLockSQL
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return {
        skipped: true,
        deleted: 0,
        aliasesDeleted: 0,
        evidenceDeleted: 0,
        alertsEnqueued: 0,
        hasMore: true,
      };
    }

    const startedAt = lock.rows[0].started_at;
    const deleted = await deleteExpiredTerminalActions(client, policy);
    const alertsEnqueued = await enqueueDueAlerts(client, startedAt, policy);
    const more = await client.query<{ terminal: boolean; unresolved: boolean }>(
      fulfillmentHousekeepingHasMoreSQL,
      [startedAt, policy.retentionDays, policy.unresolvedAlertHours, policy.alertRepeatHours]
    );
    await client.query("COMMIT");
    return {
      skipped: false,
      ...deleted,
      alertsEnqueued,
      hasMore: Boolean(more.rows[0]?.terminal || more.rows[0]?.unresolved),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
