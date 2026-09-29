import { createHash } from "crypto";
import type { QueryResultRow } from "pg";

import { queryDatabase } from "@/lib/db/database";

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
    `INSERT INTO public.pending_lifecycle_actions (
       shopify_order_id,
       shopify_order_name,
       action,
       event_name,
       event_data,
       idempotency_key,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
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
    `WITH candidates AS (
       SELECT id
       FROM public.pending_lifecycle_actions
       WHERE (status = 'pending' AND available_at <= now())
          OR (status = 'processing' AND lease_expires_at <= now())
       ORDER BY
         CASE action WHEN 'cancel' THEN 0 WHEN 'refund' THEN 1 ELSE 2 END,
         created_at,
         id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.pending_lifecycle_actions AS pending
     SET status = 'processing',
         claim_token = $2::uuid,
         claimed_at = now(),
         lease_expires_at = now() + ($3 * interval '1 second'),
         attempts = pending.attempts + 1,
         last_error = NULL
     FROM candidates
     WHERE pending.id = candidates.id
     RETURNING pending.id`,
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
    `SELECT
       pending.id,
       pending.shopify_order_id,
       pending.shopify_order_name,
       pending.action,
       pending.event_name,
       pending.event_data,
       pending.idempotency_key,
       pending.attempts,
       pending.created_at,
       EXISTS (
         SELECT 1
         FROM public.pending_lifecycle_actions AS cancellation
         WHERE cancellation.shopify_order_id = pending.shopify_order_id
           AND cancellation.action = 'cancel'
           AND cancellation.status IN ('pending', 'processing', 'published')
       ) AS blocked_by_cancellation
     FROM public.pending_lifecycle_actions AS pending
     WHERE pending.status = 'processing'
       AND pending.claim_token = $1::uuid
     ORDER BY
       CASE pending.action WHEN 'cancel' THEN 0 WHEN 'refund' THEN 1 ELSE 2 END,
       pending.created_at,
       pending.id`,
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
    `UPDATE public.pending_lifecycle_actions
     SET status = CASE
           WHEN id = ANY($2::uuid[]) THEN 'published'
           ELSE 'superseded'
         END,
         published_at = CASE WHEN id = ANY($2::uuid[]) THEN now() ELSE published_at END,
         superseded_at = CASE WHEN id = ANY($3::uuid[]) THEN now() ELSE superseded_at END,
         last_error = CASE
           WHEN id = ANY($3::uuid[]) THEN 'Superseded by a pending cancellation for the same order'
           ELSE NULL
         END,
         claim_token = NULL,
         lease_expires_at = NULL
     WHERE status = 'processing'
       AND claim_token = $1::uuid
       AND (id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))
     RETURNING id`,
    [claimToken, publishedIds, supersededIds]
  );
  return result.rowCount ?? 0;
}
