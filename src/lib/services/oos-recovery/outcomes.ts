import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";
import { lockOosRecoveryOrder } from "./locking";

export type OosRecoveryOutcome = {
  dependencies: number;
  manualReview: boolean;
};

export type OosRetryContext = {
  provider: "gps" | "d365";
  warehouse: string;
  blockedItems: Array<{ orderLineId: string; providerSku: string }>;
  manualReview: boolean;
  attemptToken: string | null;
};

export type OosRecoveryAttemptScope = Pick<
  OosRetryContext,
  "provider" | "warehouse" | "blockedItems"
>;

export type OosRecoveryMutationLease = {
  shopifyStore: string;
  orderId: string;
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
  operationKey: string;
  leaseToken: string;
};

type LockedOosDependency = {
  id: string;
  provider: "gps" | "d365";
  warehouse: string;
  order_line_id: string;
  sku: string;
  status: "parked" | "leased" | "retrying" | "manual_review";
  replay_token: string | null;
};

function dependencyIdentity(value: {
  provider: string;
  warehouse: string;
  orderLineId: string;
  providerSku: string;
}): string {
  return JSON.stringify([value.provider, value.warehouse, value.orderLineId, value.providerSku]);
}

export async function lockMatchingOosRecoveryAttempt(
  client: PoolClient,
  params: {
    shopifyStore: string;
    orderId: string;
    attemptToken: string;
    expectedContext: OosRecoveryAttemptScope;
    allowedStatuses: LockedOosDependency["status"][];
    allowConcurrentMutationForAttempt?: boolean;
  }
): Promise<string[] | null> {
  await lockOosRecoveryOrder(client, params.shopifyStore, params.orderId);
  const activeMutation = await client.query<{ replay_token: string }>(
    `SELECT replay_token
     FROM public.oos_recovery_mutation_leases
     WHERE lower(shopify_store) = lower($1) AND order_id = $2 AND lease_until > now()
     FOR UPDATE`,
    [params.shopifyStore, params.orderId]
  );
  if (
    activeMutation.rows.some(
      (row) => !params.allowConcurrentMutationForAttempt || row.replay_token !== params.attemptToken
    )
  ) {
    return null;
  }
  const result = await client.query<LockedOosDependency>(
    `SELECT id, provider, warehouse, order_line_id, sku, status, replay_token
     FROM public.oos_recovery_dependencies
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND status IN ('parked', 'leased', 'retrying', 'manual_review')
     ORDER BY id
     FOR UPDATE`,
    [params.shopifyStore, params.orderId]
  );
  const expected = new Set(
    params.expectedContext.blockedItems.map((item) =>
      dependencyIdentity({
        provider: params.expectedContext.provider,
        warehouse: params.expectedContext.warehouse,
        orderLineId: item.orderLineId,
        providerSku: item.providerSku,
      })
    )
  );
  if (
    expected.size === 0 ||
    expected.size !== params.expectedContext.blockedItems.length ||
    result.rows.length !== expected.size ||
    result.rows.some(
      (row) =>
        row.replay_token !== params.attemptToken ||
        !params.allowedStatuses.includes(row.status) ||
        !expected.has(
          dependencyIdentity({
            provider: row.provider,
            warehouse: row.warehouse,
            orderLineId: row.order_line_id,
            providerSku: row.sku,
          })
        )
    )
  ) {
    return null;
  }
  return result.rows.map((row) => row.id);
}

export async function isCurrentOosRecoveryAttempt(params: {
  shopifyStore: string;
  orderId: string;
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
}): Promise<boolean> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery validation requires the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      ...params,
      allowedStatuses: ["retrying"],
    });
    await client.query("COMMIT");
    return ids !== null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimOosRecoveryMutation(params: {
  shopifyStore: string;
  orderId: string;
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
  operationKey: string;
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<OosRecoveryMutationLease | null> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery mutation requires the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      ...params,
      allowedStatuses: ["retrying"],
      allowConcurrentMutationForAttempt: true,
    });
    if (!ids) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `WITH obsolete AS (
         SELECT mutation.id FROM public.oos_recovery_mutation_leases mutation
         WHERE mutation.created_at <= now() - interval '30 days'
           AND NOT EXISTS (
             SELECT 1 FROM public.oos_recovery_dependencies dependency
             WHERE lower(dependency.shopify_store) = lower(mutation.shopify_store)
               AND dependency.order_id = mutation.order_id
               AND dependency.status IN ('parked', 'leased', 'retrying', 'manual_review')
           )
         ORDER BY mutation.created_at, mutation.id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       DELETE FROM public.oos_recovery_mutation_leases AS mutation
       USING obsolete WHERE mutation.id = obsolete.id`
    );
    const existingOperation = await client.query<{
      id: string;
      replay_token: string;
      state: "pending" | "accepted" | "rejected" | "uncertain";
      lease_until: Date | null;
    }>(
      `SELECT id, replay_token, state, lease_until
       FROM public.oos_recovery_mutation_leases
       WHERE lower(shopify_store) = lower($1) AND order_id = $2
         AND operation_key = $3
       ORDER BY created_at, id FOR UPDATE`,
      [params.shopifyStore, params.orderId, params.operationKey]
    );
    const expiredPendingIds = existingOperation.rows
      .filter(
        (row) =>
          row.state === "pending" &&
          row.lease_until !== null &&
          new Date(row.lease_until).getTime() <= Date.now()
      )
      .map((row) => row.id);
    if (expiredPendingIds.length) {
      await client.query(
        `UPDATE public.oos_recovery_mutation_leases
         SET state = 'uncertain', lease_until = NULL, finished_at = now()
         WHERE id = ANY($1::uuid[]) AND state = 'pending' AND lease_until <= now()`,
        [expiredPendingIds]
      );
    }
    if (
      existingOperation.rows.some(
        (row) => row.state !== "rejected" || row.replay_token === params.attemptToken
      )
    ) {
      await client.query("COMMIT");
      return null;
    }
    const leaseToken = randomUUID();
    await client.query(
      `INSERT INTO public.oos_recovery_mutation_leases (
         id, shopify_store, order_id, replay_token, operation_key, lease_owner, lease_until
       ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, now() + make_interval(secs => $7))`,
      [
        leaseToken,
        params.shopifyStore,
        params.orderId,
        params.attemptToken,
        params.operationKey,
        params.leaseOwner,
        Math.max(30, params.leaseSeconds),
      ]
    );
    await client.query("COMMIT");
    return {
      shopifyStore: params.shopifyStore,
      orderId: params.orderId,
      attemptToken: params.attemptToken,
      expectedContext: params.expectedContext,
      operationKey: params.operationKey,
      leaseToken,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function renewOosRecoveryMutation(
  lease: OosRecoveryMutationLease,
  leaseSeconds: number
): Promise<boolean> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery mutation requires the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      shopifyStore: lease.shopifyStore,
      orderId: lease.orderId,
      attemptToken: lease.attemptToken,
      expectedContext: lease.expectedContext,
      allowedStatuses: ["retrying"],
      allowConcurrentMutationForAttempt: true,
    });
    if (!ids) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `UPDATE public.oos_recovery_mutation_leases
       SET lease_until = now() + make_interval(secs => $5)
       WHERE id = $1::uuid AND lower(shopify_store) = lower($2) AND order_id = $3
         AND replay_token = $4::uuid AND state = 'pending' AND lease_until > now()`,
      [
        lease.leaseToken,
        lease.shopifyStore,
        lease.orderId,
        lease.attemptToken,
        Math.max(30, leaseSeconds),
      ]
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseOosRecoveryMutation(
  lease: OosRecoveryMutationLease,
  outcome: "accepted" | "rejected" | "uncertain" = "accepted"
): Promise<boolean> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery mutation requires the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      shopifyStore: lease.shopifyStore,
      orderId: lease.orderId,
      attemptToken: lease.attemptToken,
      expectedContext: lease.expectedContext,
      allowedStatuses: ["retrying"],
      allowConcurrentMutationForAttempt: true,
    });
    if (!ids) {
      await client.query("COMMIT");
      return false;
    }
    const result = await client.query(
      `UPDATE public.oos_recovery_mutation_leases
       SET state = $6, lease_until = NULL, finished_at = now()
       WHERE id = $1::uuid AND lower(shopify_store) = lower($2) AND order_id = $3
         AND replay_token = $4::uuid AND operation_key = $5
         AND state = 'pending' AND lease_until > now()`,
      [
        lease.leaseToken,
        lease.shopifyStore,
        lease.orderId,
        lease.attemptToken,
        lease.operationKey,
        outcome,
      ]
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadOosRetryContext(params: {
  shopifyStore: string;
  orderId: string;
  includeManualReview?: boolean;
}): Promise<OosRetryContext | null> {
  const pool = await getDatabasePool();
  if (!pool) return null;
  const result = await pool.query<{
    provider: "gps" | "d365";
    warehouse: string;
    order_line_id: string;
    sku: string;
    status: string;
    replay_token: string | null;
  }>(
    `SELECT provider, warehouse, order_line_id, sku, status, replay_token
     FROM public.oos_recovery_dependencies
     WHERE lower(shopify_store) = lower($1) AND order_id = $2
       AND (status IN ('parked', 'leased', 'retrying') OR ($3 AND status = 'manual_review'))
     ORDER BY first_parked_at, id`,
    [params.shopifyStore, params.orderId, params.includeManualReview ?? false]
  );
  if (result.rows.length === 0) return null;
  const provider = result.rows[0].provider;
  const warehouse = result.rows[0].warehouse;
  if (result.rows.some((row) => row.provider !== provider || row.warehouse !== warehouse)) {
    throw new Error("OOS retry context spans more than one provider inventory scope");
  }
  const attemptTokens = new Set(result.rows.map((row) => row.replay_token));
  if (attemptTokens.size > 1 && !params.includeManualReview) {
    throw new Error("OOS retry context spans more than one recovery attempt");
  }
  const attemptToken = attemptTokens.size === 1 ? result.rows[0].replay_token : null;
  return {
    provider,
    warehouse,
    blockedItems: result.rows
      .map((row) => ({ orderLineId: row.order_line_id, providerSku: row.sku }))
      .sort((a, b) =>
        `${a.orderLineId}:${a.providerSku}`.localeCompare(`${b.orderLineId}:${b.providerSku}`)
      ),
    manualReview:
      result.rows.some((row) => row.status === "manual_review") || attemptTokens.size > 1,
    attemptToken,
  };
}

export async function rearmManualReviewOosDependencies(params: {
  shopifyStore: string;
  orderId: string;
  retentionDays: number;
}): Promise<string | null> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS manual recovery requires the configured PostgreSQL database");
  const attemptToken = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockOosRecoveryOrder(client, params.shopifyStore, params.orderId);
    const activeMutation = await client.query(
      `SELECT 1 FROM public.oos_recovery_mutation_leases
       WHERE lower(shopify_store) = lower($1) AND order_id = $2 AND lease_until > now()
       LIMIT 1`,
      [params.shopifyStore, params.orderId]
    );
    if (activeMutation.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const dependencies = await client.query<{ id: string }>(
      `SELECT id FROM public.oos_recovery_dependencies
       WHERE lower(shopify_store) = lower($1) AND order_id = $2
         AND status IN ('parked', 'leased', 'retrying', 'manual_review')
       ORDER BY id FOR UPDATE`,
      [params.shopifyStore, params.orderId]
    );
    if (!dependencies.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const result = await client.query<{ replay_token: string }>(
      `UPDATE public.oos_recovery_dependencies
     SET status = 'retrying', manual_review_at = NULL, resolved_at = NULL,
       attempt_count = CASE
         WHEN status IN ('parked', 'manual_review') THEN attempt_count + 1
         ELSE attempt_count
       END,
       last_attempt_at = now(), cooldown_until = NULL,
       next_attempt_at = now(), expires_at = GREATEST(
         expires_at,
         now() + make_interval(days => $2)
       ),
       lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       replay_token = $3::uuid,
       last_error_code = 'manual_rearmed', version = version + 1
     WHERE id = ANY($1::uuid[])
     RETURNING replay_token`,
      [dependencies.rows.map((row) => row.id), Math.max(1, params.retentionDays), attemptToken]
    );
    if (result.rowCount !== dependencies.rowCount) {
      throw new Error("OOS manual rearm changed an incomplete dependency set");
    }
    await client.query("COMMIT");
    return result.rowCount ? attemptToken : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
  /** A correlated replay may close rows moved to review by an earlier failed attempt. */
  includeManualReview?: boolean;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      ...params,
      allowedStatuses: params.includeManualReview ? ["retrying", "manual_review"] : ["retrying"],
    });
    if (!ids) {
      await client.query("COMMIT");
      return { dependencies: 0, manualReview: false };
    }
    const result = await client.query(
      `UPDATE public.oos_recovery_dependencies
     SET status = 'resolved', resolved_at = now(), cooldown_until = NULL,
       next_attempt_at = now(), lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       manual_review_at = NULL, last_error_code = NULL, version = version + 1
     WHERE id = ANY($1::uuid[])
       AND replay_token = $2::uuid
       AND (status = 'retrying' OR ($3 AND status = 'manual_review'))`,
      [ids, params.attemptToken, params.includeManualReview ?? false]
    );
    if (result.rowCount !== ids.length) {
      throw new Error("OOS resolution changed an incomplete recovery attempt");
    }
    if (result.rowCount) {
      await updateOrderState(client, {
        orderId: params.orderId,
        status: "processing",
        processingStatus: "processing",
        clearError: true,
        state: { oosRecovery: false, oosRecoveryOutcome: "resolved" },
      });
    }
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
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
  cooldownSeconds: number;
  maxAttempts: number;
  errorCode: string;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      ...params,
      allowedStatuses: ["retrying"],
    });
    if (!ids) {
      await client.query("COMMIT");
      return { dependencies: 0, manualReview: false };
    }
    const result = await client.query<{ status: string }>(
      `UPDATE public.oos_recovery_dependencies
     SET status = CASE
         WHEN attempt_count >= $2 OR expires_at <= now() THEN 'manual_review'
         ELSE 'parked'
       END,
       cooldown_until = CASE
         WHEN attempt_count >= $2 OR expires_at <= now() THEN NULL
         ELSE now() + make_interval(secs => $3)
       END,
       next_attempt_at = CASE
         WHEN attempt_count >= $2 OR expires_at <= now() THEN next_attempt_at
         ELSE now() + make_interval(secs => $3)
       END,
       manual_review_at = CASE
         WHEN attempt_count >= $2 OR expires_at <= now() THEN now()
         ELSE NULL
       END,
       lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       replay_token = CASE
         WHEN attempt_count >= $2 OR expires_at <= now() THEN replay_token
         ELSE NULL
       END,
       last_error_code = $4, version = version + 1
     WHERE id = ANY($1::uuid[])
       AND status = 'retrying' AND replay_token = $5::uuid
     RETURNING status`,
      [
        ids,
        Math.max(1, params.maxAttempts),
        Math.max(1, params.cooldownSeconds),
        params.errorCode,
        params.attemptToken,
      ]
    );
    if (result.rowCount !== ids.length) {
      throw new Error("OOS repark changed an incomplete recovery attempt");
    }
    const manualReview = result.rows.some((row) => row.status === "manual_review");
    if (result.rowCount) {
      await updateOrderState(client, {
        orderId: params.orderId,
        status: "failed",
        processingStatus: "backorder",
        state: {
          oosRecovery: true,
          oosRecoveryOutcome: manualReview ? "manual_review" : "parked",
        },
      });
    }
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
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
  errorCode: string;
}): Promise<OosRecoveryOutcome> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS recovery outcomes require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = await lockMatchingOosRecoveryAttempt(client, {
      ...params,
      allowedStatuses: ["retrying", "manual_review"],
    });
    if (!ids) {
      await client.query("COMMIT");
      return { dependencies: 0, manualReview: true };
    }
    const result = await client.query(
      `UPDATE public.oos_recovery_dependencies
     SET status = 'manual_review', manual_review_at = now(), cooldown_until = NULL,
       lease_owner = NULL, lease_token = NULL, lease_until = NULL,
       last_error_code = $2, version = version + 1
     WHERE id = ANY($1::uuid[])
       AND status IN ('retrying', 'manual_review') AND replay_token = $3::uuid`,
      [ids, params.errorCode, params.attemptToken]
    );
    if (result.rowCount !== ids.length) {
      throw new Error("OOS manual-review transition changed an incomplete recovery attempt");
    }
    if (result.rowCount) {
      await updateOrderState(client, {
        orderId: params.orderId,
        status: "failed",
        processingStatus: "backorder",
        state: { oosRecovery: true, oosRecoveryOutcome: "manual_review" },
      });
    }
    await client.query("COMMIT");
    return { dependencies: result.rowCount ?? 0, manualReview: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
