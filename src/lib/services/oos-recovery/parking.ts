import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";
import type { InventoryDependency } from "./inventory-failure";

export type OosRecoveryContext = {
  d365OrderNumber?: string;
  sourceEventName?: string;
  failureStage?: "order_creation" | "fulfillment";
  retryMode?: "gps_outbound" | "fulfillment_replay";
  backorderQueue?: "sync" | "fulfilment";
  maxRetries: number;
};

export type ParkOosOrderParams = {
  dependencies: InventoryDependency[];
  context: OosRecoveryContext;
  retentionDays: number;
  now?: Date;
};

function validateDependencies(dependencies: InventoryDependency[]): void {
  if (dependencies.length === 0 || dependencies.length > 500) {
    throw new Error("OOS parking requires between 1 and 500 dependencies");
  }
  const first = dependencies[0];
  for (const dependency of dependencies) {
    if (
      dependency.shopifyOrderId !== first.shopifyOrderId ||
      dependency.shopifyOrderName !== first.shopifyOrderName ||
      dependency.shopifyStore !== first.shopifyStore
    ) {
      throw new Error("OOS dependencies must belong to one Shopify order and store");
    }
    if (
      !dependency.orderLineId.trim() ||
      !dependency.sku.trim() ||
      !dependency.warehouse.trim() ||
      !Number.isSafeInteger(dependency.quantityNeeded) ||
      dependency.quantityNeeded <= 0
    ) {
      throw new Error("OOS dependency keys and quantities must be valid");
    }
  }
}

export function buildOosParkedEvent(params: ParkOosOrderParams) {
  validateDependencies(params.dependencies);
  const first = params.dependencies[0];
  const identity = params.dependencies
    .map((item) => [item.provider, item.warehouse, item.sku, item.orderLineId, item.quantityNeeded])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        first.shopifyStore,
        first.shopifyOrderId,
        params.context.sourceEventName ?? "shopify/order.paid",
        identity,
      ])
    )
    .digest("hex");
  const failedSkus = [...new Set(params.dependencies.map((item) => item.sku))].sort();
  return {
    id: `oos-parked-${digest}`,
    name: "backorder/created" as const,
    data: {
      shopifyOrderId: first.shopifyOrderId,
      shopifyOrderName: first.shopifyOrderName,
      shopifyStore: first.shopifyStore,
      d365OrderNumber: params.context.d365OrderNumber ?? "",
      warehouse: first.warehouse,
      errorMessage: "Inventory dependency parked for targeted recovery",
      errorType:
        first.safeFailureCategory === "item_not_found"
          ? ("d365_item_not_found" as const)
          : first.safeFailureCategory,
      failedSkus,
      retryCount: 0,
      maxRetries: params.context.maxRetries,
      createdAt: (params.now ?? new Date()).toISOString(),
      sourceEventName: params.context.sourceEventName ?? "shopify/order.paid",
      failureStage: params.context.failureStage ?? "order_creation",
      failureSystem: first.provider,
      retryMode: params.context.retryMode ?? "gps_outbound",
      backorderQueue: params.context.backorderQueue ?? "sync",
      targetedRecovery: true,
    },
  };
}

export async function parkOosOrderWithClient(
  client: PoolClient,
  params: ParkOosOrderParams
): Promise<{ dependencyIds: string[]; outboxId: string; eventId: string }> {
  validateDependencies(params.dependencies);
  const first = params.dependencies[0];
  const now = params.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + Math.max(1, params.retentionDays) * 24 * 60 * 60 * 1000
  );
  const event = buildOosParkedEvent({ ...params, now });

  await client.query(
    `INSERT INTO public.orders (
       id, order_number, title, status, platform, platform_order_id, platform_order_name,
       shopify_order_id, shopify_order_name, processing_status, last_error,
       last_error_type, warehouse, state, retry_at
     ) VALUES ($1, $2, $2, 'failed', 'shopify', $1, $2, $1, $2, 'backorder',
       'Inventory dependency parked for targeted recovery', $3, $4,
       jsonb_build_object('oosRecovery', true, 'provider', $5::text), now())
     ON CONFLICT (id) DO UPDATE SET
       status = 'failed',
       processing_status = 'backorder',
       last_error = EXCLUDED.last_error,
       last_error_type = EXCLUDED.last_error_type,
       warehouse = EXCLUDED.warehouse,
       state = COALESCE(public.orders.state, '{}'::jsonb) || EXCLUDED.state,
       retry_at = EXCLUDED.retry_at`,
    [
      first.shopifyOrderId,
      first.shopifyOrderName,
      first.safeFailureCategory,
      first.warehouse,
      first.provider,
    ]
  );

  const dependencyIds: string[] = [];
  for (const dependency of params.dependencies) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO public.oos_recovery_dependencies (
         order_id, order_name, order_line_id, shopify_store, provider, warehouse, sku,
         quantity_needed, failure_category, status, d365_order_number, source_event_name,
         failure_stage, retry_mode, backorder_queue, first_parked_at, next_attempt_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 'parked', $10, $11, $12, $13, $14,
         $15, $15, $16
       )
       ON CONFLICT (shopify_store, order_id, order_line_id, provider, warehouse, sku)
         WHERE status IN ('parked', 'leased', 'retrying')
       DO UPDATE SET
         quantity_needed = EXCLUDED.quantity_needed,
         failure_category = EXCLUDED.failure_category,
         status = 'parked',
         d365_order_number = EXCLUDED.d365_order_number,
         source_event_name = EXCLUDED.source_event_name,
         failure_stage = EXCLUDED.failure_stage,
         retry_mode = EXCLUDED.retry_mode,
         backorder_queue = EXCLUDED.backorder_queue,
         last_attempt_at = now(),
         attempt_count = public.oos_recovery_dependencies.attempt_count + 1,
         cooldown_until = NULL,
         next_attempt_at = EXCLUDED.next_attempt_at,
         expires_at = GREATEST(public.oos_recovery_dependencies.expires_at, EXCLUDED.expires_at),
         lease_owner = NULL,
         lease_token = NULL,
         lease_until = NULL,
         version = public.oos_recovery_dependencies.version + 1,
         last_error_code = EXCLUDED.failure_category
       RETURNING id`,
      [
        dependency.shopifyOrderId,
        dependency.shopifyOrderName,
        dependency.orderLineId,
        dependency.shopifyStore,
        dependency.provider,
        dependency.warehouse,
        dependency.sku,
        dependency.quantityNeeded,
        dependency.safeFailureCategory,
        params.context.d365OrderNumber ?? "",
        params.context.sourceEventName ?? null,
        params.context.failureStage ?? "order_creation",
        params.context.retryMode ?? "gps_outbound",
        params.context.backorderQueue ?? "sync",
        now,
        expiresAt,
      ]
    );
    dependencyIds.push(result.rows[0].id);
  }

  const outbox = await client.query<{ id: string }>(
    `INSERT INTO public.oos_recovery_outbox (event_id, event_name, event_data)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (event_id) DO UPDATE SET
       event_data = EXCLUDED.event_data,
       status = CASE
         WHEN public.oos_recovery_outbox.status = 'published' THEN 'published'
         ELSE 'queued'
       END,
       next_attempt_at = now(),
       lease_token = NULL,
       lease_until = NULL,
       last_error_code = NULL
     RETURNING id`,
    [event.id, event.name, JSON.stringify(event.data)]
  );

  return { dependencyIds, outboxId: outbox.rows[0].id, eventId: event.id };
}

export async function parkOosOrder(
  params: ParkOosOrderParams
): Promise<{ dependencyIds: string[]; outboxId: string; eventId: string }> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS parking requires the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await parkOosOrderWithClient(client, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
