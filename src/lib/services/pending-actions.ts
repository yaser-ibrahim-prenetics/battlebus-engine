// ============================================================================
// DURABLE PENDING LIFECYCLE ACTIONS
// ============================================================================
// Normalized PostgreSQL queue for lifecycle actions that must be replayed after
// their target order is available. Stable producer IDs deduplicate enqueue;
// stable action IDs deduplicate downstream publication; leases isolate workers.

import { config } from "@/lib/config";
import { queryDatabase } from "@/lib/db/database";
import { claimPendingActionsSQL } from "@/lib/sql/pending-actions/claim";
import {
  enqueueLegacyPendingActionSQL,
  enqueuePendingActionSQL,
} from "@/lib/sql/pending-actions/enqueue";
import { completePendingActionSQL, retryPendingActionSQL } from "@/lib/sql/pending-actions/finish";
import { importLegacyPendingActionsSQL } from "@/lib/sql/pending-actions/import-legacy";

export type PendingActionType = "fulfill" | "cancel" | "refund";

export interface PendingAction {
  action: PendingActionType;
  eventName: string;
  eventData: Record<string, unknown>;
  sourceEventId: string;
}

export interface ClaimedPendingAction {
  actionId: string;
  orderId: string;
  action: PendingActionType;
  eventName: string;
  eventData: Record<string, unknown>;
  leaseToken: string;
  attempts: number;
}

type PendingActionRow = {
  action_id: string;
  order_id: string;
  action_type: PendingActionType;
  event_name: string;
  event_data: Record<string, unknown>;
  lease_token: string;
  attempts: number;
};

function requiredString(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function assertEventData(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending action event data");
  }
}

export async function storePendingAction(
  orderId: string | number,
  action: PendingAction
): Promise<string> {
  const normalizedOrderId = requiredString(String(orderId), "pending action order ID", 255);
  const sourceEventId = requiredString(
    action.sourceEventId,
    "pending action source event ID",
    1024
  );
  const eventName = requiredString(action.eventName, "pending action event name", 255);
  assertEventData(action.eventData);
  if (!(["cancel", "refund", "fulfill"] as const).includes(action.action)) {
    throw new Error("Invalid pending action type");
  }

  const legacyPayload = JSON.stringify({
    action: action.action,
    eventName,
    eventData: action.eventData,
    sourceEventId,
    createdAt: new Date().toISOString(),
  });

  if (!config.pendingActions.durableQueueEnabled) {
    const legacyResult = await queryDatabase<{ id: string }>(enqueueLegacyPendingActionSQL, [
      normalizedOrderId,
      action.action,
      sourceEventId,
      eventName,
      JSON.stringify(action.eventData),
      legacyPayload,
    ]);
    if (legacyResult.rowCount !== 1) {
      throw new Error(`Legacy pending action order not found: ${normalizedOrderId}`);
    }
    console.log(`[PendingActions] Queued legacy ${action.action} orderId=${normalizedOrderId}`);
    return `legacy:${sourceEventId}`;
  }

  const { rows } = await queryDatabase<{ action_id: string; legacy_projected: boolean }>(
    enqueuePendingActionSQL,
    [
      normalizedOrderId,
      action.action,
      sourceEventId,
      eventName,
      JSON.stringify(action.eventData),
      legacyPayload,
      config.pendingActions.legacyProjectionEnabled,
    ]
  );
  const actionId = rows[0]?.action_id;
  if (!actionId) throw new Error("Pending action enqueue returned no action ID");

  console.log(
    `[PendingActions] Queued ${action.action} actionId=${actionId} orderId=${normalizedOrderId}`
  );
  return actionId;
}

export async function importLegacyPendingActions(): Promise<{
  imported: number;
  sourceOrders: number;
}> {
  const { rows } = await queryDatabase<{ imported: string; source_orders: string }>(
    importLegacyPendingActionsSQL,
    [config.pendingActions.legacyImportOrderLimit]
  );
  return {
    imported: Number(rows[0]?.imported || 0),
    sourceOrders: Number(rows[0]?.source_orders || 0),
  };
}

export async function claimPendingActions(): Promise<ClaimedPendingAction[]> {
  const { rows } = await queryDatabase<PendingActionRow>(claimPendingActionsSQL, [
    config.pendingActions.claimBatchSize,
    config.pendingActions.leaseSeconds,
    config.pendingActions.maxAttempts,
  ]);
  return rows.map((row) => ({
    actionId: row.action_id,
    orderId: row.order_id,
    action: row.action_type,
    eventName: row.event_name,
    eventData: row.event_data,
    leaseToken: row.lease_token,
    attempts: row.attempts,
  }));
}

export async function completePendingAction(action: ClaimedPendingAction): Promise<void> {
  const result = await queryDatabase<{ action_id: string }>(completePendingActionSQL, [
    action.actionId,
    action.leaseToken,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`Pending action lease lost before acknowledgement: ${action.actionId}`);
  }
}

export async function retryPendingAction(action: ClaimedPendingAction): Promise<void> {
  const result = await queryDatabase<{ action_id: string; status: string }>(retryPendingActionSQL, [
    action.actionId,
    action.leaseToken,
    config.pendingActions.maxAttempts,
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`Pending action lease lost before retry: ${action.actionId}`);
  }
}
