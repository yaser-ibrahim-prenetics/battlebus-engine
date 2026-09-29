import type { QueryResultRow } from "pg";

import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

export type RefundOperationState =
  | "awaiting_order"
  | "dispatching"
  | "processing"
  | "creating_line"
  | "line_created"
  | "completed"
  | "dead_letter";

export interface RefundOperationClaim {
  claimed: boolean;
  state: RefundOperationState;
  claimToken: string | null;
  d365OrderNumber: string | null;
  inventoryLotId: string | null;
  externalIdempotencyKey: string | null;
}

export interface RefundRecoveryDispatch {
  refundId: string;
  shopifyOrderId: string;
  eventName: string;
  eventData: Record<string, unknown>;
  attempts: number;
}

export interface RefundRecoveryClaimResult {
  claimedCount: number;
  deadLetteredCount: number;
}

interface RefundOperationClaimRow extends QueryResultRow {
  claimed: boolean;
  state: RefundOperationState;
  claim_token: string | null;
  d365_order_number: string | null;
  inventory_lot_id: string | null;
  external_idempotency_key: string | null;
}

interface RefundRecoveryDispatchRow extends QueryResultRow {
  refund_id: string;
  shopify_order_id: string;
  event_name: string;
  event_data: Record<string, unknown>;
  attempts: number;
}

interface RefundRecoveryClaimRow extends QueryResultRow {
  claimed_count: number;
  dead_lettered_count: number;
}

function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new Error("Cloud SQL is required for database-enforced refund deduplication");
  }
}

function mapClaim(row: RefundOperationClaimRow): RefundOperationClaim {
  return {
    claimed: row.claimed,
    state: row.state,
    claimToken: row.claim_token,
    d365OrderNumber: row.d365_order_number ?? null,
    inventoryLotId: row.inventory_lot_id ?? null,
    externalIdempotencyKey: row.external_idempotency_key ?? null,
  };
}

export async function reserveRefundOperation({
  refundId,
  shopifyOrderId,
  eventName,
  eventData,
  claimToken,
  leaseSeconds = 900,
}: {
  refundId: string;
  shopifyOrderId: string;
  eventName: string;
  eventData: Record<string, unknown>;
  claimToken: string;
  leaseSeconds?: number;
}): Promise<RefundOperationClaim> {
  requireDatabase();
  const safeLeaseSeconds = Math.max(60, Math.min(leaseSeconds, 3600));
  const result = await queryDatabase<RefundOperationClaimRow>(
    `WITH claimed AS (
       INSERT INTO public.refund_operations (
         refund_id,
         shopify_order_id,
         event_name,
         event_data,
         state,
         claim_token,
         lease_expires_at
       )
       VALUES ($1, $2, $3, $4::jsonb, 'processing', $5::uuid, now() + ($6 * interval '1 second'))
       ON CONFLICT (refund_id) DO UPDATE
       SET shopify_order_id = EXCLUDED.shopify_order_id,
           event_name = EXCLUDED.event_name,
           event_data = EXCLUDED.event_data,
           state = 'processing',
           claim_token = EXCLUDED.claim_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           attempts = refund_operations.attempts + 1,
           last_error = NULL
       WHERE refund_operations.state = 'awaiting_order'
         AND refund_operations.available_at <= now()
       RETURNING true AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key FROM claimed
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key
     FROM public.refund_operations
     WHERE refund_id = $1
       AND NOT EXISTS (SELECT 1 FROM claimed)
     LIMIT 1`,
    [refundId, shopifyOrderId, eventName, JSON.stringify(eventData), claimToken, safeLeaseSeconds]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Refund operation ${refundId} could not be reserved`);
  return mapClaim(row);
}

export async function acceptRefundRecovery({
  refundId,
  claimToken,
  leaseSeconds = 900,
}: {
  refundId: string;
  claimToken: string;
  leaseSeconds?: number;
}): Promise<RefundOperationClaim> {
  requireDatabase();
  const safeLeaseSeconds = Math.max(60, Math.min(leaseSeconds, 3600));
  const result = await queryDatabase<RefundOperationClaimRow>(
    `WITH accepted AS (
       UPDATE public.refund_operations
       SET state = resume_state,
           resume_state = NULL,
           lease_expires_at = now() + ($3 * interval '1 second'),
           last_error = NULL
       WHERE refund_id = $1
         AND claim_token = $2::uuid
         AND state = 'dispatching'
       RETURNING true AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key FROM accepted
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key
     FROM public.refund_operations
     WHERE refund_id = $1
       AND NOT EXISTS (SELECT 1 FROM accepted)
     LIMIT 1`,
    [refundId, claimToken, safeLeaseSeconds]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Refund recovery ${refundId} does not exist`);
  return mapClaim(row);
}

export async function deferRefundUntilOrder({
  refundId,
  claimToken,
  eventName,
  eventData,
  error,
}: {
  refundId: string;
  claimToken: string;
  eventName: string;
  eventData: Record<string, unknown>;
  error: string;
}): Promise<void> {
  requireDatabase();
  const result = await queryDatabase<{ refund_id: string }>(
    `UPDATE public.refund_operations
     SET state = 'awaiting_order',
         event_name = $3,
         event_data = $4::jsonb,
         available_at = now() + (
           LEAST(3600, 60 * power(2, LEAST(attempts - 1, 6))) * interval '1 second'
         ),
         claim_token = NULL,
         lease_expires_at = NULL,
         last_error = $5
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state = 'processing'
     RETURNING refund_id`,
    [refundId, claimToken, eventName, JSON.stringify(eventData), error]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Refund operation ${refundId} is not owned by claim ${claimToken}`);
  }
}

export async function beginRefundLineCreation({
  refundId,
  claimToken,
  externalIdempotencyKey,
  leaseSeconds = 900,
}: {
  refundId: string;
  claimToken: string;
  externalIdempotencyKey: string;
  leaseSeconds?: number;
}): Promise<RefundOperationClaim> {
  requireDatabase();
  const safeLeaseSeconds = Math.max(60, Math.min(leaseSeconds, 3600));
  const result = await queryDatabase<RefundOperationClaimRow>(
    `WITH started AS (
       UPDATE public.refund_operations
       SET state = 'creating_line',
           external_idempotency_key = $3,
           lease_expires_at = now() + ($4 * interval '1 second'),
           last_error = NULL
       WHERE refund_id = $1
         AND claim_token = $2::uuid
         AND state = 'processing'
         AND (external_idempotency_key IS NULL OR external_idempotency_key = $3)
       RETURNING true AS claimed, state, claim_token,
         d365_order_number, inventory_lot_id, external_idempotency_key
     )
     SELECT claimed, state, claim_token, d365_order_number, inventory_lot_id,
       external_idempotency_key FROM started
     UNION ALL
     SELECT false AS claimed, state, claim_token, d365_order_number,
       inventory_lot_id, external_idempotency_key
     FROM public.refund_operations
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND NOT EXISTS (SELECT 1 FROM started)
     LIMIT 1`,
    [refundId, claimToken, externalIdempotencyKey, safeLeaseSeconds]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Refund operation ${refundId} lost ownership before line creation`);
  return mapClaim(row);
}

export async function markRefundLineCreated({
  refundId,
  claimToken,
  d365OrderNumber,
  inventoryLotId,
}: {
  refundId: string;
  claimToken: string;
  d365OrderNumber: string;
  inventoryLotId: string;
}): Promise<void> {
  requireDatabase();
  const result = await queryDatabase<{ refund_id: string }>(
    `UPDATE public.refund_operations
     SET state = 'line_created',
         d365_order_number = $3,
         inventory_lot_id = $4,
         line_created_at = now(),
         last_error = NULL
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state = 'creating_line'
     RETURNING refund_id`,
    [refundId, claimToken, d365OrderNumber, inventoryLotId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Refund operation ${refundId} lost ownership before line creation`);
  }
}

export async function completeRefundOperation({
  refundId,
  claimToken,
  d365OrderNumber,
  inventoryLotId,
}: {
  refundId: string;
  claimToken: string;
  d365OrderNumber?: string | null;
  inventoryLotId?: string | null;
}): Promise<void> {
  requireDatabase();
  const result = await queryDatabase<{ refund_id: string }>(
    `UPDATE public.refund_operations
     SET state = 'completed',
         event_data = '{}'::jsonb,
         claim_token = NULL,
         lease_expires_at = NULL,
         d365_order_number = COALESCE($3, d365_order_number),
         inventory_lot_id = COALESCE($4, inventory_lot_id),
         completed_at = now(),
         last_error = NULL
     WHERE refund_id = $1
       AND claim_token = $2::uuid
       AND state IN ('processing', 'line_created')
     RETURNING refund_id`,
    [refundId, claimToken, d365OrderNumber ?? null, inventoryLotId ?? null]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Refund operation ${refundId} could not be completed by claim ${claimToken}`);
  }
}

export async function claimRefundRecoveries({
  claimToken,
  batchSize = 50,
  leaseSeconds = 300,
  maxAttempts = 12,
}: {
  claimToken: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
}): Promise<RefundRecoveryClaimResult> {
  requireDatabase();
  const safeBatchSize = Math.max(1, Math.min(batchSize, 100));
  const safeLeaseSeconds = Math.max(60, Math.min(leaseSeconds, 900));
  const safeMaxAttempts = Math.max(2, Math.min(maxAttempts, 100));
  const result = await queryDatabase<RefundRecoveryClaimRow>(
    `WITH dead_lettered AS (
       UPDATE public.refund_operations
       SET state = 'dead_letter',
           event_data = '{}'::jsonb,
           claim_token = NULL,
           lease_expires_at = NULL,
           resume_state = NULL,
           dead_lettered_at = now(),
           last_error = concat_ws('; ', NULLIF(last_error, ''), 'Recovery attempt limit reached')
       WHERE attempts >= $4
         AND (
           (state = 'awaiting_order' AND available_at <= now())
           OR (
             state IN ('dispatching', 'processing', 'creating_line', 'line_created')
             AND lease_expires_at <= now()
           )
         )
       RETURNING refund_id
     ), candidates AS (
       SELECT refund_id
       FROM public.refund_operations
       WHERE attempts < $4
         AND (
           (state = 'awaiting_order' AND available_at <= now())
           OR (
             state IN ('dispatching', 'processing', 'creating_line', 'line_created')
             AND lease_expires_at <= now()
           )
         )
       ORDER BY available_at, created_at, refund_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE public.refund_operations AS operation
       SET state = 'dispatching',
           resume_state = CASE
             WHEN operation.state = 'awaiting_order' THEN 'processing'
             WHEN operation.state = 'dispatching' THEN operation.resume_state
             ELSE operation.state
           END,
           claim_token = $2::uuid,
           lease_expires_at = now() + ($3 * interval '1 second'),
           attempts = operation.attempts + 1
       FROM candidates
       WHERE operation.refund_id = candidates.refund_id
       RETURNING operation.refund_id
     )
     SELECT
       (SELECT count(*) FROM claimed)::integer AS claimed_count,
       (SELECT count(*) FROM dead_lettered)::integer AS dead_lettered_count`,
    [safeBatchSize, claimToken, safeLeaseSeconds, safeMaxAttempts]
  );
  const row = result.rows[0];
  return {
    claimedCount: row?.claimed_count ?? 0,
    deadLetteredCount: row?.dead_lettered_count ?? 0,
  };
}

export async function loadRefundRecoveryDispatches({
  claimToken,
}: {
  claimToken: string;
}): Promise<RefundRecoveryDispatch[]> {
  requireDatabase();
  const result = await queryDatabase<RefundRecoveryDispatchRow>(
    `SELECT refund_id, shopify_order_id, event_name, event_data, attempts
     FROM public.refund_operations
     WHERE state = 'dispatching'
       AND claim_token = $1::uuid
     ORDER BY created_at, refund_id`,
    [claimToken]
  );
  return result.rows.map((row) => ({
    refundId: row.refund_id,
    shopifyOrderId: row.shopify_order_id,
    eventName: row.event_name,
    eventData: row.event_data,
    attempts: row.attempts,
  }));
}
