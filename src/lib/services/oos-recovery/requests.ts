import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";
import type { InventoryProvider } from "./inventory-failure";

export type OosDrainMode = "inventory_event" | "manual" | "sweep";

export type OosDrainRequestInput = {
  mode: OosDrainMode;
  dryRun: boolean;
  provider?: InventoryProvider;
  warehouse?: string;
  sku?: string;
  orderId?: string;
  shopifyStore?: string;
  parkedFrom?: string;
  parkedTo?: string;
  observedQuantity?: number;
  observedAt?: string;
  sourceEventId?: string;
  requestedBy?: string;
  batchLimit: number;
};

export type OosDrainRequest = Omit<OosDrainRequestInput, "requestedBy"> & {
  id: string;
  laneKey: string;
  slot: "active" | "successor";
  status: "queued" | "leased" | "completed" | "failed";
  leaseToken?: string;
  attemptCount: number;
};

function normalizedTimestamp(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return timestamp.toISOString();
}

export function normalizeOosDrainRequest(input: OosDrainRequestInput): OosDrainRequestInput {
  if (!Number.isInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > 1000) {
    throw new Error("OOS drain batchLimit must be between 1 and 1000");
  }
  const provider = input.provider;
  if (provider !== undefined && provider !== "gps" && provider !== "d365") {
    throw new Error("OOS drain provider must be gps or d365");
  }
  const warehouse = input.warehouse?.trim().toUpperCase() || undefined;
  const sku = input.sku?.trim().toUpperCase() || undefined;
  const orderId = input.orderId?.trim() || undefined;
  const shopifyStore = input.shopifyStore?.trim().toLowerCase() || undefined;
  const keyedTarget = Boolean(provider && warehouse && sku);
  const orderTarget = Boolean(orderId && shopifyStore);
  if ((provider || warehouse || sku) && !keyedTarget) {
    throw new Error("OOS inventory targets require provider, warehouse and SKU together");
  }
  if ((orderId || shopifyStore) && !orderTarget) {
    throw new Error("OOS order targets require orderId and shopifyStore together");
  }
  if (input.mode !== "sweep" && !keyedTarget && !orderTarget) {
    throw new Error("Targeted OOS drains require a provider/warehouse/SKU key or order/store");
  }
  if (
    input.observedQuantity !== undefined &&
    (!Number.isSafeInteger(input.observedQuantity) || input.observedQuantity < 0)
  ) {
    throw new Error("OOS observedQuantity must be a non-negative integer");
  }
  const observedAt = normalizedTimestamp("observedAt", input.observedAt);
  if (input.mode === "inventory_event" && (!input.sourceEventId?.trim() || !observedAt)) {
    throw new Error("Inventory-event drains require sourceEventId and observedAt");
  }
  const parkedFrom = normalizedTimestamp("parkedFrom", input.parkedFrom);
  const parkedTo = normalizedTimestamp("parkedTo", input.parkedTo);
  if (parkedFrom && parkedTo && parkedFrom > parkedTo) {
    throw new Error("parkedFrom must be before parkedTo");
  }
  return {
    ...input,
    provider,
    warehouse,
    sku,
    orderId,
    shopifyStore,
    parkedFrom,
    parkedTo,
    observedAt,
    sourceEventId: input.sourceEventId?.trim() || undefined,
    requestedBy: input.requestedBy?.trim() || undefined,
  };
}

export function oosDrainLaneKey(input: OosDrainRequestInput): string {
  const normalized = normalizeOosDrainRequest(input);
  const lane = normalized.dryRun ? "dry" : "live";
  if (normalized.orderId) {
    return `${lane}:order:${normalized.shopifyStore}:${normalized.orderId}`;
  }
  if (normalized.provider) {
    return `${lane}:inventory:${normalized.provider}:${normalized.warehouse}:${normalized.sku}`;
  }
  return `${lane}:sweep`;
}

function requestedByHash(requestedBy: string | undefined): string | null {
  return requestedBy
    ? createHash("sha256").update(requestedBy.toLowerCase()).digest("hex")
    : null;
}

function rowToRequest(row: Record<string, unknown>): OosDrainRequest {
  return {
    id: String(row.id),
    laneKey: String(row.lane_key),
    slot: row.slot as "active" | "successor",
    mode: row.mode as OosDrainMode,
    dryRun: Boolean(row.dry_run),
    provider: (row.provider as InventoryProvider | null) ?? undefined,
    warehouse: (row.warehouse as string | null) ?? undefined,
    sku: (row.sku as string | null) ?? undefined,
    orderId: (row.order_id as string | null) ?? undefined,
    shopifyStore: (row.shopify_store as string | null) ?? undefined,
    parkedFrom: row.parked_from ? new Date(String(row.parked_from)).toISOString() : undefined,
    parkedTo: row.parked_to ? new Date(String(row.parked_to)).toISOString() : undefined,
    observedQuantity:
      row.observed_quantity === null || row.observed_quantity === undefined
        ? undefined
        : Number(row.observed_quantity),
    observedAt: row.observed_at ? new Date(String(row.observed_at)).toISOString() : undefined,
    sourceEventId: (row.source_event_id as string | null) ?? undefined,
    batchLimit: Number(row.batch_limit),
    status: row.status as OosDrainRequest["status"],
    leaseToken: (row.lease_token as string | null) ?? undefined,
    attemptCount: Number(row.attempt_count),
  };
}

const RETURNING = `RETURNING id, lane_key, slot, mode, dry_run, provider, warehouse, sku,
  order_id, shopify_store, parked_from, parked_to, observed_quantity, observed_at,
  source_event_id, batch_limit, status, lease_token, attempt_count`;

async function writeRequest(
  client: PoolClient,
  id: string | undefined,
  slot: "active" | "successor",
  input: OosDrainRequestInput,
  laneKey: string
): Promise<OosDrainRequest> {
  const values = [
    laneKey,
    slot,
    input.mode,
    input.dryRun,
    input.provider ?? null,
    input.warehouse ?? null,
    input.sku ?? null,
    input.orderId ?? null,
    input.shopifyStore ?? null,
    input.parkedFrom ?? null,
    input.parkedTo ?? null,
    input.observedQuantity ?? null,
    input.observedAt ?? null,
    input.sourceEventId ?? null,
    requestedByHash(input.requestedBy),
    input.batchLimit,
  ];
  const result = id
    ? await client.query(
        `UPDATE public.oos_drain_requests SET
           mode = $3, dry_run = $4, provider = $5, warehouse = $6, sku = $7,
           order_id = $8, shopify_store = $9, parked_from = $10, parked_to = $11,
           observed_quantity = $12, observed_at = $13, source_event_id = $14,
           requested_by_hash = $15, batch_limit = $16, last_error_code = NULL
         WHERE id = $17 AND status = 'queued'
         ${RETURNING}`,
        [...values, id]
      )
    : await client.query(
        `INSERT INTO public.oos_drain_requests (
           lane_key, slot, mode, dry_run, provider, warehouse, sku, order_id,
           shopify_store, parked_from, parked_to, observed_quantity, observed_at,
           source_event_id, requested_by_hash, batch_limit
         ) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
         ${RETURNING}`,
        values
      );
  if (result.rowCount !== 1) throw new Error("OOS drain request changed while coalescing");
  return rowToRequest(result.rows[0]);
}

async function enqueueRequestEvent(client: PoolClient, request: OosDrainRequest): Promise<void> {
  await client.query(
    `INSERT INTO public.oos_recovery_outbox (event_id, event_name, event_data)
     VALUES ($1, 'oos/drain.requested',
       jsonb_build_object('requestId', $2::text, 'laneKey', $3::text))
     ON CONFLICT (event_id) DO NOTHING`,
    [`oos-drain-requested-${request.id}`, request.id, request.laneKey]
  );
}

export async function submitOosDrainRequest(
  rawInput: OosDrainRequestInput
): Promise<{ request: OosDrainRequest; created: boolean }> {
  const input = normalizeOosDrainRequest(rawInput);
  const laneKey = oosDrainLaneKey(input);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain requests require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      "oos-drain",
      laneKey,
    ]);
    const open = await client.query(
      `SELECT * FROM public.oos_drain_requests
       WHERE lane_key = $1 AND status IN ('queued', 'leased')
       ORDER BY CASE slot WHEN 'active' THEN 0 ELSE 1 END
       FOR UPDATE`,
      [laneKey]
    );
    const duplicate = open.rows.find(
      (row) => input.sourceEventId && row.source_event_id === input.sourceEventId
    );
    if (duplicate) {
      await client.query("COMMIT");
      return { request: rowToRequest(duplicate), created: false };
    }
    const active = open.rows.find((row) => row.slot === "active");
    const queuedSuccessor = open.rows.find(
      (row) => row.slot === "successor" && row.status === "queued"
    );
    const slot = active?.status === "leased" ? "successor" : "active";
    const replaceId = slot === "successor" ? queuedSuccessor?.id : active?.status === "queued" ? active.id : undefined;
    const request = await writeRequest(client, replaceId, slot, input, laneKey);
    if (request.slot === "active") await enqueueRequestEvent(client, request);
    await client.query("COMMIT");
    return { request, created: !replaceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimOosDrainRequest(
  requestId: string,
  leaseSeconds: number
): Promise<OosDrainRequest | null> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain requests require the configured PostgreSQL database");
  const result = await pool.query(
    `UPDATE public.oos_drain_requests
     SET status = 'leased', lease_token = gen_random_uuid(),
       lease_until = now() + make_interval(secs => $2), attempt_count = attempt_count + 1
     WHERE id = $1 AND slot = 'active'
       AND (status = 'queued' OR (status = 'leased' AND lease_until <= now()))
     ${RETURNING}`,
    [requestId, Math.max(30, Math.min(1800, leaseSeconds))]
  );
  return result.rows[0] ? rowToRequest(result.rows[0]) : null;
}

export async function finishOosDrainRequest(params: {
  request: OosDrainRequest;
  resultEvidence: Record<string, number | string | boolean>;
  errorCode?: string;
}): Promise<string | null> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain requests require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const finished = await client.query(
      `UPDATE public.oos_drain_requests
       SET status = $3, completed_at = now(), result_evidence = $4::jsonb,
         last_error_code = $5, lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
       RETURNING lane_key`,
      [
        params.request.id,
        params.request.leaseToken,
        params.errorCode ? "failed" : "completed",
        JSON.stringify(params.resultEvidence),
        params.errorCode?.slice(0, 160) ?? null,
      ]
    );
    if (finished.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const successor = await client.query<{ id: string }>(
      `UPDATE public.oos_drain_requests
       SET slot = 'active'
       WHERE id = (
         SELECT id FROM public.oos_drain_requests
         WHERE lane_key = $1 AND slot = 'successor' AND status = 'queued'
         ORDER BY created_at, id LIMIT 1 FOR UPDATE
       )
       RETURNING id`,
      [params.request.laneKey]
    );
    if (successor.rows[0]?.id) {
      await client.query(
        `INSERT INTO public.oos_recovery_outbox (event_id, event_name, event_data)
         SELECT $1, 'oos/drain.requested',
           jsonb_build_object('requestId', id::text, 'laneKey', lane_key)
         FROM public.oos_drain_requests WHERE id = $2
         ON CONFLICT (event_id) DO NOTHING`,
        [`oos-drain-requested-${successor.rows[0].id}`, successor.rows[0].id]
      );
    }
    await client.query("COMMIT");
    return successor.rows[0]?.id ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function retryOosDrainRequest(
  request: OosDrainRequest,
  errorCode: string
): Promise<boolean> {
  const pool = await getDatabasePool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE public.oos_drain_requests
     SET status = 'queued', lease_token = NULL, lease_until = NULL,
       last_error_code = $3
     WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
    [request.id, request.leaseToken, errorCode.slice(0, 160)]
  );
  return result.rowCount === 1;
}
