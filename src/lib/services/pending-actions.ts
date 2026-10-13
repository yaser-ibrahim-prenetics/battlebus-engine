import { createHash } from "crypto";
import type { QueryResultRow } from "pg";

import { queryDatabase } from "@/lib/db/database";
import { pendingActionQueries } from "@/lib/db/queries/pending-actions";

export type PendingActionType = "fulfill" | "cancel" | "refund";
export type PendingActionStatus = "pending" | "processing" | "published" | "superseded";

export interface PendingAction {
  action: PendingActionType;
  eventName: string;
  eventData: Record<string, unknown>;
  createdAt: string;
}

export interface ClaimedPendingAction extends PendingAction {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  idempotencyKey: string;
  attempts: number;
  blockedByCancellation: boolean;
}

interface PendingActionRow extends QueryResultRow {
  id: string;
  shopify_order_id: string;
  shopify_order_name: string | null;
  action: PendingActionType;
  event_name: string;
  event_data: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
  blocked_by_cancellation: boolean;
  created_at: Date | string;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item) ?? null);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((normalized, key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) normalized[key] = normalizeJson(item);
        return normalized;
      }, {});
  }
  return value;
}

export function buildPendingActionIdempotencyKey(
  shopifyOrderId: string,
  action: Pick<PendingAction, "action" | "eventName" | "eventData">
): string {
  const source = JSON.stringify({
    shopifyOrderId: String(shopifyOrderId).trim(),
    action: action.action,
    eventName: action.eventName,
    eventData: normalizeJson(action.eventData),
  });
  return createHash("sha256").update(source).digest("hex");
}

function mapRow(row: PendingActionRow): ClaimedPendingAction {
  return {
    id: row.id,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderName: row.shopify_order_name,
    action: row.action,
    eventName: row.event_name,
    eventData: row.event_data,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    blockedByCancellation: row.blocked_by_cancellation,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function storePendingAction(
  shopifyOrderId: string,
  action: PendingAction
): Promise<void> {
  const normalizedOrderId = String(shopifyOrderId).trim();
  if (!normalizedOrderId) throw new Error("shopifyOrderId is required");

  const idempotencyKey = buildPendingActionIdempotencyKey(normalizedOrderId, action);
  const shopifyOrderName =
    typeof action.eventData.shopifyOrderName === "string"
      ? action.eventData.shopifyOrderName
      : null;

  const result = await queryDatabase<{ id: string }>(
    pendingActionQueries.store,
    [
      normalizedOrderId,
      shopifyOrderName,
      action.action,
      action.eventName,
      JSON.stringify(action.eventData),
      idempotencyKey,
      action.createdAt,
    ]
  );

  console.log(
    result.rowCount === 1
      ? `[PendingActions] Queued ${action.action} for shopifyOrderId=${normalizedOrderId}`
      : `[PendingActions] Duplicate ${action.action} already queued for shopifyOrderId=${normalizedOrderId}`
  );
}

export async function claimPendingActions({
  claimToken,
  batchSize = 200,
  leaseSeconds = 300,
}: {
  claimToken: string;
  batchSize?: number;
  leaseSeconds?: number;
}): Promise<number> {
  const safeBatchSize = Math.max(1, Math.min(batchSize, 500));
  const safeLeaseSeconds = Math.max(30, Math.min(leaseSeconds, 900));
  const result = await queryDatabase<{ id: string }>(
    pendingActionQueries.claim,
    [safeBatchSize, claimToken, safeLeaseSeconds]
  );
  return result.rowCount ?? result.rows.length;
}

export async function loadClaimedPendingActions({
  claimToken,
}: {
  claimToken: string;
}): Promise<ClaimedPendingAction[]> {
  const result = await queryDatabase<PendingActionRow>(
    pendingActionQueries.loadClaimed,
    [claimToken]
  );
  return result.rows.map(mapRow);
}

export async function completePendingActions({
  claimToken,
  publishedIds,
  supersededIds,
}: {
  claimToken: string;
  publishedIds: string[];
  supersededIds: string[];
}): Promise<number> {
  if (publishedIds.length === 0 && supersededIds.length === 0) return 0;

  const result = await queryDatabase<{ id: string }>(
    pendingActionQueries.complete,
    [claimToken, publishedIds, supersededIds]
  );
  return result.rowCount ?? 0;
}
