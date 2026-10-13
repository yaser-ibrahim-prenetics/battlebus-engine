import type { QueryResultRow } from "pg";

import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { refundOperationQueries } from "@/lib/db/queries/refund-operations";

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
  holdUntil?: string | null;
  holdReason?: string | null;
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
  hold_until: Date | string | null;
  hold_reason: string | null;
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
    holdUntil:
      row.hold_until instanceof Date
        ? row.hold_until.toISOString()
        : row.hold_until
          ? String(row.hold_until)
          : null,
    holdReason: row.hold_reason ?? null,
  };
}

export async function reserveRefundOperation({
  refundId,
  shopifyOrderId,
  eventName,
  eventData,
  claimToken,
  holdUntil = null,
  holdReason = null,
  leaseSeconds = 900,
}: {
  refundId: string;
  shopifyOrderId: string;
  eventName: string;
  eventData: Record<string, unknown>;
  claimToken: string;
  holdUntil?: Date | null;
  holdReason?: string | null;
  leaseSeconds?: number;
}): Promise<RefundOperationClaim> {
  requireDatabase();
  const safeLeaseSeconds = Math.max(60, Math.min(leaseSeconds, 3600));
  const result = await queryDatabase<RefundOperationClaimRow>(
    refundOperationQueries.reserve,
    [
      refundId,
      shopifyOrderId,
      eventName,
      JSON.stringify(eventData),
      claimToken,
      safeLeaseSeconds,
      holdUntil,
      holdReason,
    ]
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
    refundOperationQueries.acceptRecovery,
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
    refundOperationQueries.deferUntilOrder,
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
    refundOperationQueries.beginLineCreation,
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
    refundOperationQueries.markLineCreated,
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
    refundOperationQueries.complete,
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
    refundOperationQueries.claimRecoveries,
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
    refundOperationQueries.loadRecoveryDispatches,
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
