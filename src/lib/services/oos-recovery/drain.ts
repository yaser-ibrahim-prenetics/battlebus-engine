import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool } from "@/lib/db/database";
import { queryD365Inventory, queryGpsWarehouseInventory } from "@/lib/services/inventory-sync";
import type { InventoryProvider } from "./inventory-failure";
import type { OosDrainRequest } from "./requests";
import { submitOosDrainRequest } from "./requests";

export type OosDependencyRow = {
  id: string;
  orderId: string;
  orderName: string;
  orderLineId: string;
  shopifyStore: string;
  provider: InventoryProvider;
  warehouse: string;
  sku: string;
  quantityNeeded: number;
  failureCategory: string;
  d365OrderNumber: string;
  sourceEventName?: string;
  failureStage: "order_creation" | "fulfillment";
  retryMode: "gps_outbound" | "fulfillment_replay";
  backorderQueue: "sync" | "fulfilment";
  firstParkedAt: string;
  version: number;
};

export type OosDrainDecision = {
  orderKey: string;
  selected: boolean;
  reason: "satisfiable" | "insufficient_inventory";
  dependencies: OosDependencyRow[];
};

export type OosDrainResult = {
  examinedOrders: number;
  selectedOrders: number;
  selectedDependencies: number;
  manualReviewExpired: number;
  queuedKeys: number;
  decisions: OosDrainDecision[];
};

export type InventoryAvailabilityReader = (
  dependencies: OosDependencyRow[]
) => Promise<Map<string, number>>;

export function oosInventoryKey(
  value: Pick<OosDependencyRow, "provider" | "warehouse" | "sku">
): string {
  return `${value.provider}:${value.warehouse.toUpperCase()}:${value.sku.toUpperCase()}`;
}

export function allocateOosOrders(
  dependencies: OosDependencyRow[],
  availability: Map<string, number>,
  orderLimit: number
): OosDrainDecision[] {
  const byOrder = new Map<string, OosDependencyRow[]>();
  for (const dependency of dependencies) {
    const orderKey = `${dependency.shopifyStore}:${dependency.orderId}`;
    const existing = byOrder.get(orderKey) ?? [];
    existing.push(dependency);
    byOrder.set(orderKey, existing);
  }
  const ordered = [...byOrder.entries()].sort(([, a], [, b]) => {
    const byTime = a[0].firstParkedAt.localeCompare(b[0].firstParkedAt);
    return byTime || a[0].id.localeCompare(b[0].id);
  });
  const remaining = new Map(
    [...availability].map(([key, quantity]) => [key, Math.max(0, Math.floor(quantity))])
  );
  const decisions: OosDrainDecision[] = [];
  let selected = 0;
  for (const [orderKey, rows] of ordered) {
    if (selected >= orderLimit) break;
    const required = new Map<string, number>();
    for (const row of rows) {
      const key = oosInventoryKey(row);
      required.set(key, (required.get(key) ?? 0) + row.quantityNeeded);
    }
    const satisfiable = [...required].every(
      ([key, quantity]) => (remaining.get(key) ?? 0) >= quantity
    );
    decisions.push({
      orderKey,
      selected: satisfiable,
      reason: satisfiable ? "satisfiable" : "insufficient_inventory",
      dependencies: rows,
    });
    if (!satisfiable) continue;
    selected++;
    for (const [key, quantity] of required) {
      remaining.set(key, (remaining.get(key) ?? 0) - quantity);
    }
  }
  return decisions;
}

function mapDependencyRow(row: Record<string, unknown>): OosDependencyRow {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    orderName: String(row.order_name),
    orderLineId: String(row.order_line_id),
    shopifyStore: String(row.shopify_store),
    provider: row.provider as InventoryProvider,
    warehouse: String(row.warehouse),
    sku: String(row.sku),
    quantityNeeded: Number(row.quantity_needed),
    failureCategory: String(row.failure_category),
    d365OrderNumber: String(row.d365_order_number ?? ""),
    sourceEventName: (row.source_event_name as string | null) ?? undefined,
    failureStage: row.failure_stage as OosDependencyRow["failureStage"],
    retryMode: row.retry_mode as OosDependencyRow["retryMode"],
    backorderQueue: row.backorder_queue as OosDependencyRow["backorderQueue"],
    firstParkedAt: new Date(String(row.first_parked_at)).toISOString(),
    version: Number(row.version),
  };
}

const DEPENDENCY_COLUMNS = `d.id, d.order_id, d.order_name, d.order_line_id,
  d.shopify_store, d.provider, d.warehouse, d.sku, d.quantity_needed,
  d.failure_category, d.d365_order_number, d.source_event_name, d.failure_stage,
  d.retry_mode, d.backorder_queue, d.first_parked_at, d.version`;

async function expireDependencies(
  client: PoolClient,
  dryRun: boolean,
  limit: number
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(1000, limit));
  if (dryRun) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT id FROM public.oos_recovery_dependencies
         WHERE status IN ('parked', 'leased', 'retrying') AND expires_at <= now()
         ORDER BY expires_at, id LIMIT $1
       ) expired`,
      [boundedLimit]
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await client.query(
    `WITH expired AS (
       SELECT id FROM public.oos_recovery_dependencies
       WHERE status IN ('parked', 'leased', 'retrying') AND expires_at <= now()
       ORDER BY expires_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.oos_recovery_dependencies AS dependency
     SET status = 'manual_review', manual_review_at = now(), last_error_code = 'expired',
       lease_owner = NULL, lease_token = NULL, lease_until = NULL
     FROM expired WHERE dependency.id = expired.id`,
    [boundedLimit]
  );
  return result.rowCount ?? 0;
}

async function loadCandidates(
  client: PoolClient,
  request: OosDrainRequest
): Promise<OosDependencyRow[]> {
  const result = await client.query(
    `WITH candidate_orders AS (
       SELECT shopify_store, order_id, min(first_parked_at) AS parked_at
       FROM public.oos_recovery_dependencies
       WHERE status IN ('parked', 'leased', 'retrying', 'manual_review')
       GROUP BY shopify_store, order_id
       HAVING bool_and(
         status = 'parked'
         AND next_attempt_at <= now()
         AND (cooldown_until IS NULL OR cooldown_until <= now())
         AND expires_at > now()
       )
       AND bool_or(
         $1::text IS NULL OR (provider = $1 AND warehouse = $2 AND sku = $3)
       )
       AND bool_or($4::text IS NULL OR order_id = $4)
       AND bool_or($5::text IS NULL OR shopify_store = $5)
       AND bool_or($6::timestamptz IS NULL OR first_parked_at >= $6)
       AND bool_or($7::timestamptz IS NULL OR first_parked_at <= $7)
       ORDER BY parked_at, shopify_store, order_id
       LIMIT $8
     )
     SELECT ${DEPENDENCY_COLUMNS}
     FROM public.oos_recovery_dependencies d
     JOIN candidate_orders c USING (shopify_store, order_id)
     WHERE d.status = 'parked'
     ORDER BY c.parked_at, d.first_parked_at, d.id`,
    [
      request.provider ?? null,
      request.warehouse ?? null,
      request.sku ?? null,
      request.orderId ?? null,
      request.shopifyStore ?? null,
      request.parkedFrom ?? null,
      request.parkedTo ?? null,
      request.batchLimit,
    ]
  );
  return result.rows.map(mapDependencyRow);
}

async function lockInventoryScopes(
  client: PoolClient,
  dependencies: OosDependencyRow[]
): Promise<Set<string>> {
  const keys = [...new Set(dependencies.map(oosInventoryKey))].sort();
  for (const key of keys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `oos-inventory:${key}`,
    ]);
  }
  return new Set(keys);
}

async function subtractOutstandingReservations(
  client: PoolClient,
  availability: Map<string, number>,
  dependencies: OosDependencyRow[]
): Promise<Map<string, number>> {
  const keys = [...new Set(dependencies.map(oosInventoryKey))];
  if (keys.length === 0) return new Map(availability);
  const reservations = await client.query<{
    provider: InventoryProvider;
    warehouse: string;
    sku: string;
    quantity: string;
  }>(
    `SELECT provider, warehouse, sku, sum(quantity_needed)::text AS quantity
     FROM public.oos_recovery_dependencies
     WHERE status = 'retrying'
       AND (provider || ':' || upper(warehouse) || ':' || upper(sku)) = ANY($1::text[])
     GROUP BY provider, warehouse, sku`,
    [keys]
  );
  const remaining = new Map(availability);
  for (const reservation of reservations.rows) {
    const key = oosInventoryKey({
      provider: reservation.provider,
      warehouse: reservation.warehouse,
      sku: reservation.sku,
    } as OosDependencyRow);
    remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - Number(reservation.quantity)));
  }
  return remaining;
}

export async function readCurrentOosInventory(
  dependencies: OosDependencyRow[]
): Promise<Map<string, number>> {
  const groups = new Map<string, OosDependencyRow[]>();
  for (const dependency of dependencies) {
    const groupKey = `${dependency.provider}:${dependency.warehouse}`;
    const rows = groups.get(groupKey) ?? [];
    rows.push(dependency);
    groups.set(groupKey, rows);
  }
  const availability = new Map<string, number>();
  for (const rows of groups.values()) {
    const { provider, warehouse } = rows[0];
    const skus = [...new Set(rows.map((row) => row.sku))];
    const levels =
      provider === "gps"
        ? await queryGpsWarehouseInventory(warehouse, skus)
        : await queryD365Inventory(skus, warehouse);
    for (const sku of skus) {
      availability.set(
        oosInventoryKey({ provider, warehouse, sku } as OosDependencyRow),
        Math.max(0, Math.floor(levels.get(sku)?.available ?? 0))
      );
    }
  }
  return availability;
}

function buildRetryEvent(rows: OosDependencyRow[], attemptToken: string) {
  const first = rows[0];
  const identity = rows
    .map((row) => [row.id, row.version])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const digest = createHash("sha256")
    .update(JSON.stringify([first.shopifyStore, first.orderId, identity]))
    .digest("hex");
  return {
    id: `oos-retry-${digest}`,
    name: "backorder/retry" as const,
    data: {
      shopifyOrderId: first.orderId,
      shopifyOrderName: first.orderName,
      shopifyStore: first.shopifyStore,
      d365OrderNumber: first.d365OrderNumber,
      warehouse: first.warehouse,
      retryCount: Math.max(...rows.map((row) => row.version)),
      triggeredBy: "auto" as const,
      sourceEventName: first.sourceEventName,
      failureStage: first.failureStage,
      failureSystem: first.provider,
      retryMode: first.retryMode,
      backorderQueue: first.backorderQueue,
      targetedRecovery: true,
      oosRecoveryAttemptToken: attemptToken,
      blockedLineIds: [...new Set(rows.map((row) => row.orderLineId))].sort(),
      blockedItems: rows
        .map((row) => ({ orderLineId: row.orderLineId, providerSku: row.sku }))
        .sort((a, b) =>
          `${a.orderLineId}:${a.providerSku}`.localeCompare(`${b.orderLineId}:${b.providerSku}`)
        ),
    },
  };
}

async function queueSelectedOrders(
  client: PoolClient,
  request: OosDrainRequest,
  decisions: OosDrainDecision[],
  availability: Map<string, number>
): Promise<OosDrainDecision[]> {
  const selected: OosDrainDecision[] = [];
  const remaining = new Map(availability);
  for (const decision of decisions.filter((item) => item.selected)) {
    const first = decision.dependencies[0];
    const locked = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked`,
      ["oos-order", decision.orderKey]
    );
    if (!locked.rows[0]?.locked) continue;
    const current = await client.query(
      `SELECT ${DEPENDENCY_COLUMNS}
       FROM public.oos_recovery_dependencies d
       WHERE d.shopify_store = $1 AND d.order_id = $2
         AND d.status = 'parked'
         AND d.next_attempt_at <= now()
         AND (d.cooldown_until IS NULL OR d.cooldown_until <= now())
         AND d.expires_at > now()
       ORDER BY d.first_parked_at, d.id
       FOR UPDATE`,
      [first.shopifyStore, first.orderId]
    );
    const rows = current.rows.map(mapDependencyRow);
    if (
      rows.length === 0 ||
      rows.length !== decision.dependencies.length ||
      rows.some(
        (row) =>
          !decision.dependencies.some(
            (candidate) => candidate.id === row.id && candidate.version === row.version
          )
      )
    ) {
      continue;
    }
    const currentDecision = allocateOosOrders(rows, remaining, 1)[0];
    if (!currentDecision?.selected) continue;
    const required = new Map<string, number>();
    for (const row of rows) {
      const key = oosInventoryKey(row);
      required.set(key, (required.get(key) ?? 0) + row.quantityNeeded);
    }
    const leaseToken = randomUUID();
    const attemptToken = randomUUID();
    const ids = rows.map((row) => row.id);
    const leased = await client.query(
      `UPDATE public.oos_recovery_dependencies
       SET status = 'leased', lease_owner = $2, lease_token = $3,
         lease_until = now() + make_interval(secs => $4), last_attempt_at = now(),
         attempt_count = attempt_count + 1
       WHERE id = ANY($1::uuid[]) AND status = 'parked'
       RETURNING id`,
      [ids, `oos-drain:${request.id}`, leaseToken, 300]
    );
    if (leased.rowCount !== rows.length) continue;
    const event = buildRetryEvent(rows, attemptToken);
    await client.query(
      `INSERT INTO public.oos_recovery_outbox (event_id, event_name, event_data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.name, JSON.stringify(event.data)]
    );
    await client.query(
      `UPDATE public.oos_recovery_dependencies
       SET status = 'retrying', lease_owner = NULL, lease_token = NULL, lease_until = NULL
         , replay_token = $3::uuid
       WHERE id = ANY($1::uuid[]) AND status = 'leased' AND lease_token = $2`,
      [ids, leaseToken, attemptToken]
    );
    await client.query(
      `UPDATE public.orders
       SET processing_status = 'retrying', retry_at = now(),
         state = COALESCE(state, '{}'::jsonb) || jsonb_build_object('oosDrainRequestId', $2::text)
       WHERE (shopify_order_id = $1 OR id = $1) AND platform = 'shopify'`,
      [first.orderId, request.id]
    );
    for (const [key, quantity] of required) {
      remaining.set(key, (remaining.get(key) ?? 0) - quantity);
    }
    selected.push({ ...currentDecision, dependencies: rows });
  }
  return selected;
}

async function queueSweepKeys(client: PoolClient, request: OosDrainRequest): Promise<number> {
  const result = await client.query<{
    provider: InventoryProvider;
    warehouse: string;
    sku: string;
  }>(
    `SELECT provider, warehouse, sku
     FROM public.oos_recovery_dependencies
     WHERE status = 'parked' AND next_attempt_at <= now()
       AND (cooldown_until IS NULL OR cooldown_until <= now()) AND expires_at > now()
       AND ($1::timestamptz IS NULL OR first_parked_at >= $1)
       AND ($2::timestamptz IS NULL OR first_parked_at <= $2)
     GROUP BY provider, warehouse, sku
     ORDER BY min(first_parked_at), provider, warehouse, sku
     LIMIT $3`,
    [request.parkedFrom ?? null, request.parkedTo ?? null, request.batchLimit]
  );
  for (const key of result.rows) {
    await submitOosDrainRequest({
      mode: "sweep",
      dryRun: request.dryRun,
      provider: key.provider,
      warehouse: key.warehouse,
      sku: key.sku,
      parkedFrom: request.parkedFrom,
      parkedTo: request.parkedTo,
      batchLimit: request.batchLimit,
    });
  }
  return result.rows.length;
}

export async function executeOosDrain(
  request: OosDrainRequest,
  inventoryReader: InventoryAvailabilityReader = readCurrentOosInventory
): Promise<OosDrainResult> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain requires the configured PostgreSQL database");
  if (request.dryRun) {
    const previewClient = await pool.connect();
    let manualReviewExpired: number;
    let candidates: OosDependencyRow[];
    try {
      manualReviewExpired = await expireDependencies(previewClient, true, request.batchLimit);
      candidates = await loadCandidates(previewClient, request);
    } finally {
      previewClient.release();
    }
    const availability = await inventoryReader(candidates);
    const decisions = allocateOosOrders(candidates, availability, request.batchLimit);
    return {
      examinedOrders: decisions.length,
      selectedOrders: decisions.filter((item) => item.selected).length,
      selectedDependencies: decisions
        .filter((item) => item.selected)
        .reduce((sum, item) => sum + item.dependencies.length, 0),
      manualReviewExpired,
      queuedKeys: 0,
      decisions,
    };
  }
  const client = await pool.connect();
  try {
    const manualReviewExpired = await expireDependencies(client, false, request.batchLimit);
    if (request.mode === "sweep" && !request.provider && !request.orderId) {
      const queuedKeys = await queueSweepKeys(client, request);
      return {
        examinedOrders: 0,
        selectedOrders: 0,
        selectedDependencies: 0,
        manualReviewExpired,
        queuedKeys,
        decisions: [],
      };
    }
    await client.query("BEGIN");
    const preliminary = await loadCandidates(client, request);
    const lockedKeys = await lockInventoryScopes(client, preliminary);
    const candidates = await loadCandidates(client, request);
    if (candidates.some((row) => !lockedKeys.has(oosInventoryKey(row)))) {
      throw new Error("OOS candidate inventory scopes changed while acquiring allocation locks");
    }
    const providerAvailability = await inventoryReader(candidates);
    const availability = await subtractOutstandingReservations(
      client,
      providerAvailability,
      candidates
    );
    const decisions = allocateOosOrders(candidates, availability, request.batchLimit);
    const selected = await queueSelectedOrders(client, request, decisions, availability);
    await client.query("COMMIT");
    return {
      examinedOrders: decisions.length,
      selectedOrders: selected.length,
      selectedDependencies: selected.reduce((sum, item) => sum + item.dependencies.length, 0),
      manualReviewExpired,
      queuedKeys: 0,
      decisions: decisions.map((decision) => ({
        ...decision,
        selected: selected.some((item) => item.orderKey === decision.orderKey),
      })),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The error may have happened before a transaction began.
    }
    throw error;
  } finally {
    client.release();
  }
}
