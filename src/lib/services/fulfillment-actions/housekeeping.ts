import type { PoolClient } from "pg";

import { getDatabasePool } from "@/lib/db/database";
import type { SlackNotification } from "@/lib/clients/slack";
import { slackNotificationId } from "@/lib/clients/slack";
import { enqueueNotificationSQL } from "@/lib/sql/slack-notifications/enqueue";
import {
  acquireFulfillmentHousekeepingLockSQL,
  authorizeFulfillmentHousekeepingSuccessorSQL,
  claimFulfillmentHousekeepingSuccessorSQL,
  consumeFulfillmentHousekeepingSuccessorSQL,
  deleteRetainedTerminalActionsSQL,
  fulfillmentHousekeepingHasMoreSQL,
  markFulfillmentAttemptAlertedSQL,
  readFulfillmentHousekeepingRunReceiptSQL,
  recordFulfillmentHousekeepingRunReceiptSQL,
  selectDueUnresolvedFulfillmentAlertsSQL,
} from "@/lib/sql/fulfillment-actions/housekeeping";

const MIN_RETENTION_DAYS = 90;
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
  quarantined: number;
  alertsEnqueued: number;
  hasMore: boolean;
  successor: FulfillmentHousekeepingSuccessor | null;
}

export interface FulfillmentHousekeepingSuccessor {
  claimId: string;
  rootRunId: string;
  batch: number;
}

export interface FulfillmentHousekeepingContinuation {
  rootRunId: string;
  batch: number;
  successorDelayMinutes: number;
  incomingClaimId?: string;
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
  assertIntegerInRange(
    "unresolvedAlertHours",
    policy.unresolvedAlertHours,
    MIN_ALERT_HOURS,
    MIN_ALERT_HOURS
  );
  assertIntegerInRange("alertRepeatHours", policy.alertRepeatHours, MIN_ALERT_HOURS, 8760);
  assertIntegerInRange("alertBatchSize", policy.alertBatchSize, 1, MAX_BATCH_SIZE);
}

function validateContinuation(continuation: FulfillmentHousekeepingContinuation) {
  if (!continuation.rootRunId || continuation.rootRunId.length > 512) {
    throw new Error("rootRunId must contain between 1 and 512 characters");
  }
  assertIntegerInRange("batch", continuation.batch, 0, 999999);
  assertIntegerInRange("successorDelayMinutes", continuation.successorDelayMinutes, 1, 60);
  if (
    continuation.incomingClaimId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      continuation.incomingClaimId
    )
  ) {
    throw new Error("incomingClaimId must be a UUID");
  }
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
    quarantined: number;
    quarantined_action_keys: string[];
  }>(deleteRetainedTerminalActionsSQL, [policy.retentionDays, policy.batchSize]);
  const result = cleanup.rows[0];
  return {
    deleted: result?.deleted ?? 0,
    aliasesDeleted: result?.aliases_deleted ?? 0,
    evidenceDeleted: result?.evidence_deleted ?? 0,
    quarantined: result?.quarantined ?? 0,
    quarantinedActionKeys: result?.quarantined_action_keys ?? [],
  };
}

async function enqueueQuarantineAlerts(
  client: PoolClient,
  actionKeys: string[],
  startedAt: Date
): Promise<number> {
  let enqueued = 0;
  for (const actionKey of actionKeys) {
    const notification: SlackNotification = {
      id: slackNotificationId(actionKey, "fulfillment-action-housekeeping-quarantine"),
      channel: "system",
      severity: "critical",
      title: "Fulfillment action retention requires review",
      summary:
        "A terminal fulfillment action was retained because its replay result did not match a supported safe codec.",
      fields: [
        { label: "Action ID", value: actionKey },
        { label: "Reason", value: "unsupported_replay_result" },
      ],
      occurredAt: startedAt.toISOString(),
    };
    const inserted = await client.query(enqueueNotificationSQL, [
      notification.id,
      JSON.stringify(notification),
    ]);
    enqueued += inserted.rowCount ?? 0;
  }
  return enqueued;
}

interface HousekeepingReceiptRow {
  deleted: number;
  aliases_deleted: number;
  evidence_deleted: number;
  quarantined: number;
  alerts_enqueued: number;
  has_more: boolean;
  successor_claim_id: string | null;
  successor_root_run_id: string | null;
  successor_batch: number | null;
}

function resultFromReceipt(row: HousekeepingReceiptRow): FulfillmentHousekeepingResult {
  const hasSuccessor =
    row.successor_claim_id !== null &&
    row.successor_root_run_id !== null &&
    row.successor_batch !== null;
  return {
    skipped: false,
    deleted: row.deleted,
    aliasesDeleted: row.aliases_deleted,
    evidenceDeleted: row.evidence_deleted,
    quarantined: row.quarantined,
    alertsEnqueued: row.alerts_enqueued,
    hasMore: row.has_more,
    successor: hasSuccessor
      ? {
          claimId: row.successor_claim_id!,
          rootRunId: row.successor_root_run_id!,
          batch: row.successor_batch!,
        }
      : null,
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
  policy: FulfillmentHousekeepingPolicy,
  continuation?: FulfillmentHousekeepingContinuation
): Promise<FulfillmentHousekeepingResult> {
  validateFulfillmentHousekeepingPolicy(policy);
  if (continuation) validateContinuation(continuation);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Fulfillment housekeeping database unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (continuation) {
      const existing = await client.query<HousekeepingReceiptRow>(
        readFulfillmentHousekeepingRunReceiptSQL,
        [continuation.rootRunId, continuation.batch]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return resultFromReceipt(existing.rows[0]);
      }
    }

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
        quarantined: 0,
        alertsEnqueued: 0,
        hasMore: false,
        successor: null,
      };
    }

    if (continuation?.incomingClaimId) {
      const consumed = await client.query<{ consumed: boolean }>(
        consumeFulfillmentHousekeepingSuccessorSQL,
        [continuation.incomingClaimId]
      );
      if (consumed.rows[0]?.consumed !== true) {
        await client.query("ROLLBACK");
        return {
          skipped: true,
          deleted: 0,
          aliasesDeleted: 0,
          evidenceDeleted: 0,
          quarantined: 0,
          alertsEnqueued: 0,
          hasMore: false,
          successor: null,
        };
      }
    }

    const startedAt = lock.rows[0].started_at;
    const deleted = await deleteExpiredTerminalActions(client, policy);
    const quarantineAlerts = await enqueueQuarantineAlerts(
      client,
      deleted.quarantinedActionKeys,
      startedAt
    );
    const unresolvedAlerts = await enqueueDueAlerts(client, startedAt, policy);
    const alertsEnqueued = quarantineAlerts + unresolvedAlerts;
    const more = await client.query<{ terminal: boolean; unresolved: boolean }>(
      fulfillmentHousekeepingHasMoreSQL,
      [startedAt, policy.retentionDays, policy.unresolvedAlertHours, policy.alertRepeatHours]
    );
    const hasMore = Boolean(more.rows[0]?.terminal || more.rows[0]?.unresolved);
    let successor: FulfillmentHousekeepingSuccessor | null = null;
    if (hasMore && continuation) {
      const nextBatch = continuation.batch + 1;
      const leaseMinutes = continuation.successorDelayMinutes + 15;
      const claimed = await client.query<{
        successor_claim_id: string;
      }>(claimFulfillmentHousekeepingSuccessorSQL, [
        continuation.rootRunId,
        nextBatch,
        continuation.successorDelayMinutes,
        leaseMinutes,
      ]);
      const row = claimed.rows[0];
      if (row) {
        successor = {
          claimId: row.successor_claim_id,
          rootRunId: continuation.rootRunId,
          batch: nextBatch,
        };
      }
    }
    if (continuation) {
      await client.query(recordFulfillmentHousekeepingRunReceiptSQL, [
        continuation.rootRunId,
        continuation.batch,
        deleted.deleted,
        deleted.aliasesDeleted,
        deleted.evidenceDeleted,
        deleted.quarantined,
        alertsEnqueued,
        hasMore,
        successor?.claimId ?? null,
        successor?.rootRunId ?? null,
        successor?.batch ?? null,
      ]);
    }
    await client.query("COMMIT");
    return {
      skipped: false,
      deleted: deleted.deleted,
      aliasesDeleted: deleted.aliasesDeleted,
      evidenceDeleted: deleted.evidenceDeleted,
      quarantined: deleted.quarantined,
      alertsEnqueued,
      hasMore,
      successor,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function authorizeFulfillmentHousekeepingSuccessor(claimId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimId)) {
    throw new Error("claimId must be a UUID");
  }
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Fulfillment housekeeping database unavailable");
  const result = await pool.query<{ authorized: boolean }>(
    authorizeFulfillmentHousekeepingSuccessorSQL,
    [claimId]
  );
  return result.rows[0]?.authorized === true;
}
