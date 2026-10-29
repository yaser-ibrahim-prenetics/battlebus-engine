import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";

export type OosRecoveryOutcome = {
  dependencies: number;
  manualReview: boolean;
};

export type OosRetryContext = {
  provider: "gps" | "d365";
  warehouse: string;
  blockedLineIds: string[];
};

export async function loadOosRetryContext(params: {
  shopifyStore: string;
  orderId: string;
}): Promise<OosRetryContext | null> {
  const pool = await getDatabasePool();
  if (!pool) return null;
  const result = await pool.query<{
    provider: "gps" | "d365";
    warehouse: string;
    order_line_id: string;
  }>(
    `SELECT provider, warehouse, order_line_id
     FROM public.oos_recovery_dependencies
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND status IN ('parked', 'leased', 'retrying')
     ORDER BY first_parked_at, id`,
    [params.shopifyStore, params.orderId]
  );
  if (result.rows.length === 0) return null;
  const provider = result.rows[0].provider;
  const warehouse = result.rows[0].warehouse;
  if (result.rows.some((row) => row.provider !== provider || row.warehouse !== warehouse)) {
    throw new Error("OOS retry context spans more than one provider inventory scope");
  }
  return {
    provider,
    warehouse,
    blockedLineIds: [...new Set(result.rows.map((row) => row.order_line_id))].sort(),
  };
}

async function updateOrderState(
  client: PoolClient,
  params: {
    orderId: string;
    status: "processing" | "failed";
    processingStatus: "processing" | "backorder";
    state: Record<string, unknown>;
    clearError?: boolean;
  }
) {
  await client.query(
    `UPDATE public.orders
     SET status = $2, processing_status = $3,
       state = COALESCE(state, '{}'::jsonb) || $4::jsonb,
       retry_at = CASE WHEN $5 THEN NULL ELSE retry_at END,
       last_error = CASE WHEN $5 THEN NULL ELSE last_error END,
       last_error_type = CASE WHEN $5 THEN NULL ELSE last_error_type END,
       updated_at = now()
     WHERE platform = 'shopify' AND (shopify_order_id = $1 OR id = $1)`,
    [
      params.orderId,
      params.status,
      params.processingStatus,
      JSON.stringify(params.state),
      params.clearError ?? false,
    ]
  );
}

export async function resolveOosDependencies(params: {
  shopifyStore: string;
  orderId: string;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE public.oos_recovery_dependencies
     SET status = 'resolved', resolved_at = now(), cooldown_until = NULL,
       next_attempt_at = now(), lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       last_error_code = NULL, version = version + 1
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND status IN ('parked', 'leased', 'retrying')`,
      [params.shopifyStore, params.orderId]
    );
    await updateOrderState(client, {
      orderId: params.orderId,
      status: "processing",
      processingStatus: "processing",
      clearError: true,
      state: { oosRecovery: false, oosRecoveryOutcome: "resolved" },
    });
    await client.query("COMMIT");
    return { dependencies: result.rowCount ?? 0, manualReview: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reparkOosDependencies(params: {
  shopifyStore: string;
  orderId: string;
  cooldownSeconds: number;
  maxAttempts: number;
  errorCode: string;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ status: string }>(
      `UPDATE public.oos_recovery_dependencies
     SET status = CASE
         WHEN attempt_count >= $3 OR expires_at <= now() THEN 'manual_review'
         ELSE 'parked'
       END,
       cooldown_until = CASE
         WHEN attempt_count >= $3 OR expires_at <= now() THEN NULL
         ELSE now() + make_interval(secs => $4)
       END,
       next_attempt_at = CASE
         WHEN attempt_count >= $3 OR expires_at <= now() THEN next_attempt_at
         ELSE now() + make_interval(secs => $4)
       END,
       manual_review_at = CASE
         WHEN attempt_count >= $3 OR expires_at <= now() THEN now()
         ELSE NULL
       END,
       lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       last_error_code = $5, version = version + 1
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND status IN ('leased', 'retrying')
     RETURNING status`,
      [
        params.shopifyStore,
        params.orderId,
        Math.max(1, params.maxAttempts),
        Math.max(1, params.cooldownSeconds),
        params.errorCode,
      ]
    );
    const manualReview = result.rows.some((row) => row.status === "manual_review");
    await updateOrderState(client, {
      orderId: params.orderId,
      status: "failed",
      processingStatus: "backorder",
      state: {
        oosRecovery: true,
        oosRecoveryOutcome: manualReview ? "manual_review" : "parked",
      },
    });
    await client.query("COMMIT");
    return { dependencies: result.rowCount ?? 0, manualReview };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function moveOosDependenciesToManualReview(params: {
  shopifyStore: string;
  orderId: string;
  errorCode: string;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE public.oos_recovery_dependencies
     SET status = 'manual_review', manual_review_at = now(), cooldown_until = NULL,
       lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       last_error_code = $3, version = version + 1
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND status IN ('parked', 'leased', 'retrying')`,
      [params.shopifyStore, params.orderId, params.errorCode]
    );
    await updateOrderState(client, {
      orderId: params.orderId,
      status: "failed",
      processingStatus: "backorder",
      state: { oosRecovery: true, oosRecoveryOutcome: "manual_review" },
    });
    await client.query("COMMIT");
    return { dependencies: result.rowCount ?? 0, manualReview: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
