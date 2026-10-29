import { createHash, randomUUID } from "node:crypto";
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
  requestReason?: string;
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

export type OosDrainCommand = {
  requestId: string;
  actor: string;
  reason: string;
};

export type OosDrainPreviewEvidence = {
  examinedOrders: number;
  selectedOrders: number;
  selectedDependencies: number;
  manualReviewExpired: number;
  queuedKeys: number;
};

export class OosDrainCommandConflictError extends Error {}
export class OosDrainCommandInProgressError extends Error {}

function normalizedTimestamp(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return timestamp.toISOString();
}

export function normalizeOosDrainRequest(input: OosDrainRequestInput): OosDrainRequestInput {
  if (!(["inventory_event", "manual", "sweep"] as const).includes(input.mode)) {
    throw new Error("OOS drain mode must be inventory_event, manual or sweep");
  }
  if (typeof input.dryRun !== "boolean") {
    throw new Error("OOS drain dryRun must be a boolean");
  }
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
    requestReason: input.requestReason?.trim() || undefined,
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

export function createOosDrainPreviewRequest(rawInput: OosDrainRequestInput): OosDrainRequest {
  const normalized = normalizeOosDrainRequest(rawInput);
  if (!normalized.dryRun) throw new Error("OOS drain previews require dryRun=true");
  const request = { ...normalized };
  delete request.requestedBy;
  return {
    ...request,
    id: `preview-${randomUUID()}`,
    laneKey: oosDrainLaneKey(normalized),
    slot: "active",
    status: "leased",
    attemptCount: 0,
  };
}

function requestedByHash(requestedBy: string | undefined): string | null {
  return requestedBy ? createHash("sha256").update(requestedBy.toLowerCase()).digest("hex") : null;
}

function commandRequestHash(input: OosDrainRequestInput, command: OosDrainCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestId: command.requestId,
        actor: command.actor,
        reason: command.reason,
        mode: input.mode,
        dryRun: input.dryRun,
        provider: input.provider ?? null,
        warehouse: input.warehouse ?? null,
        sku: input.sku ?? null,
        orderId: input.orderId ?? null,
        shopifyStore: input.shopifyStore ?? null,
        parkedFrom: input.parkedFrom ?? null,
        parkedTo: input.parkedTo ?? null,
        observedQuantity: input.observedQuantity ?? null,
        observedAt: input.observedAt ?? null,
        batchLimit: input.batchLimit,
      })
    )
    .digest("hex");
}

function validateCommand(command: OosDrainCommand): OosDrainCommand {
  const requestId = command.requestId.trim().toLowerCase();
  const actor = command.actor.trim().toLowerCase();
  const reason = command.reason.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
  ) {
    throw new Error("OOS drain command requires a UUID requestId");
  }
  if (!actor || reason.length < 10 || reason.length > 1000) {
    throw new Error("OOS drain command requires an authenticated actor and audit reason");
  }
  return { requestId, actor, reason };
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
    JSON.stringify(input.requestReason ? { requestReason: input.requestReason } : {}),
  ];
  const result = id
    ? await client.query(
        `UPDATE public.oos_drain_requests SET
           mode = $1, dry_run = $2, provider = $3, warehouse = $4, sku = $5,
           order_id = $6, shopify_store = $7, parked_from = $8, parked_to = $9,
           observed_quantity = $10, observed_at = $11, source_event_id = $12,
           requested_by_hash = $13, batch_limit = $14,
           result_evidence = result_evidence || $15::jsonb, last_error_code = NULL
         WHERE id = $16 AND status = 'queued'
         ${RETURNING}`,
        [...values.slice(2), id]
      )
    : await client.query(
        `INSERT INTO public.oos_drain_requests (
           lane_key, slot, mode, dry_run, provider, warehouse, sku, order_id,
           shopify_store, parked_from, parked_to, observed_quantity, observed_at,
           source_event_id, requested_by_hash, batch_limit, result_evidence
         ) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
         ${RETURNING}`,
        values
      );
  if (result.rowCount !== 1) throw new Error("OOS drain request changed while coalescing");
  return rowToRequest(result.rows[0]);
}

async function enqueueRequestEvent(
  client: PoolClient,
  request: Pick<OosDrainRequest, "id" | "laneKey">
): Promise<"dispatched" | "outstanding" | "exhausted"> {
  const latest = await client.query<{ status: string; exhausted: boolean }>(
    `SELECT status, (status = 'failed' AND next_attempt_at = 'infinity'::timestamptz) AS exhausted
     FROM public.oos_recovery_outbox
     WHERE event_name = 'oos/drain.requested' AND event_data->>'requestId' = $1
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [request.id]
  );
  if (latest.rows[0]?.exhausted) return "exhausted";
  if (
    latest.rows[0]?.status === "queued" ||
    latest.rows[0]?.status === "leased" ||
    latest.rows[0]?.status === "failed"
  ) {
    return "outstanding";
  }
  const dispatch = await client.query<{ dispatch_count: number }>(
    `UPDATE public.oos_drain_requests
     SET dispatch_count = dispatch_count + 1
     WHERE id = $1 AND slot = 'active' AND status = 'queued'
     RETURNING dispatch_count`,
    [request.id]
  );
  if (dispatch.rowCount !== 1) return "outstanding";
  await client.query(
    `INSERT INTO public.oos_recovery_outbox (event_id, event_name, event_data)
     VALUES ($1, 'oos/drain.requested',
       jsonb_build_object('requestId', $2::text, 'laneKey', $3::text))
     ON CONFLICT (event_id) DO NOTHING`,
    [
      `oos-drain-requested-${request.id}-${dispatch.rows[0].dispatch_count}`,
      request.id,
      request.laneKey,
    ]
  );
  return "dispatched";
}

export async function submitOosDrainRequest(
  rawInput: OosDrainRequestInput,
  rawCommand?: OosDrainCommand
): Promise<{ request: OosDrainRequest; created: boolean }> {
  const input = normalizeOosDrainRequest(rawInput);
  if (input.dryRun) {
    throw new Error("Dry-run OOS drains must use the non-persistent preview path");
  }
  const command = rawCommand ? validateCommand(rawCommand) : undefined;
  const requestHash = command ? commandRequestHash(input, command) : undefined;
  const laneKey = oosDrainLaneKey(input);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain requests require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (command && requestHash) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `oos-command:${command.requestId}`,
      ]);
      const receipt = await client.query<{
        request_hash: string;
        drain_request_id: string | null;
      }>(
        `SELECT request_hash, drain_request_id FROM public.oos_drain_command_receipts
         WHERE request_id = $1`,
        [command.requestId]
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_hash !== requestHash) {
          throw new OosDrainCommandConflictError(
            "OOS drain requestId conflicts with an existing command"
          );
        }
        const existing = receipt.rows[0].drain_request_id
          ? await client.query("SELECT * FROM public.oos_drain_requests WHERE id = $1", [
              receipt.rows[0].drain_request_id,
            ])
          : { rows: [] };
        if (!existing.rows[0]) {
          throw new OosDrainCommandConflictError("OOS drain command has no durable request");
        }
        await client.query("COMMIT");
        return { request: rowToRequest(existing.rows[0]), created: false };
      }
    }
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
    const replaceId =
      slot === "successor"
        ? queuedSuccessor?.id
        : active?.status === "queued"
          ? active.id
          : undefined;
    const request = await writeRequest(client, replaceId, slot, input, laneKey);
    if (request.slot === "active") await enqueueRequestEvent(client, request);
    if (command && requestHash) {
      await client.query(
        `INSERT INTO public.oos_drain_command_receipts (
           request_id, request_hash, drain_request_id, lane_key, dry_run,
           actor_hash, reason
         ) VALUES ($1, $2, $3, $4, false, $5, $6)`,
        [
          command.requestId,
          requestHash,
          request.id,
          laneKey,
          requestedByHash(command.actor),
          command.reason,
        ]
      );
    }
    await client.query("COMMIT");
    return { request, created: !replaceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveOosDrainPreviewCommand(
  rawInput: OosDrainRequestInput,
  rawCommand: OosDrainCommand
): Promise<{ status: "execute" } | { status: "completed"; result: OosDrainPreviewEvidence }> {
  const input = normalizeOosDrainRequest(rawInput);
  if (!input.dryRun) throw new Error("OOS preview command requires dryRun=true");
  const command = validateCommand(rawCommand);
  const requestHash = commandRequestHash(input, command);
  const actorHash = requestedByHash(command.actor)!;
  const laneKey = oosDrainLaneKey(input);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain previews require the configured PostgreSQL database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `oos-command:${command.requestId}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `oos-preview-actor:${actorHash}`,
    ]);
    const existing = await client.query<{
      request_hash: string;
      status: "accepted" | "completed" | "failed";
      result_evidence: OosDrainPreviewEvidence | null;
      stale: boolean;
    }>(
      `SELECT request_hash, status, result_evidence,
         created_at <= now() - interval '5 minutes' AS stale
       FROM public.oos_drain_command_receipts WHERE request_id = $1`,
      [command.requestId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new OosDrainCommandConflictError(
          "OOS preview requestId conflicts with an existing command"
        );
      }
      if (existing.rows[0].status === "completed" && existing.rows[0].result_evidence) {
        await client.query("COMMIT");
        return { status: "completed", result: existing.rows[0].result_evidence };
      }
      if (existing.rows[0].status === "accepted" && !existing.rows[0].stale) {
        throw new OosDrainCommandInProgressError("OOS preview command is already running");
      }
      await client.query(
        `UPDATE public.oos_drain_command_receipts
         SET status = 'accepted', result_evidence = NULL, completed_at = NULL
         WHERE request_id = $1`,
        [command.requestId]
      );
    } else {
      const active = await client.query(
        `SELECT 1 FROM public.oos_drain_command_receipts
         WHERE actor_hash = $1 AND dry_run AND status = 'accepted'
           AND created_at > now() - interval '5 minutes'
         LIMIT 1`,
        [actorHash]
      );
      if (active.rowCount) {
        throw new OosDrainCommandInProgressError(
          "An OOS preview is already running for this operations principal"
        );
      }
      await client.query(
        `INSERT INTO public.oos_drain_command_receipts (
           request_id, request_hash, lane_key, dry_run, actor_hash, reason
         ) VALUES ($1, $2, $3, true, $4, $5)`,
        [command.requestId, requestHash, laneKey, actorHash, command.reason]
      );
    }
    await client.query("COMMIT");
    return { status: "execute" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishOosDrainPreviewCommand(params: {
  requestId: string;
  result?: OosDrainPreviewEvidence;
  errorCode?: string;
}): Promise<void> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS drain previews require the configured PostgreSQL database");
  await pool.query(
    `UPDATE public.oos_drain_command_receipts
     SET status = $2, result_evidence = $3::jsonb, completed_at = now()
     WHERE request_id = $1 AND dry_run AND status = 'accepted'`,
    [
      params.requestId,
      params.errorCode ? "failed" : "completed",
      JSON.stringify(params.result ?? { errorCode: params.errorCode ?? "preview_failed" }),
    ]
  );
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
       SET status = $3, completed_at = now(), result_evidence = result_evidence || $4::jsonb,
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
      await enqueueRequestEvent(client, {
        id: successor.rows[0].id,
        laneKey: params.request.laneKey,
      });
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE public.oos_drain_requests
       SET status = 'queued', lease_token = NULL, lease_until = NULL,
         last_error_code = $3
       WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [request.id, request.leaseToken, errorCode.slice(0, 160)]
    );
    if (result.rowCount === 1) await enqueueRequestEvent(client, request);
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function redispatchStalledOosDrainRequests(limit: number): Promise<number> {
  const pool = await getDatabasePool();
  if (!pool) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.oos_drain_requests
       SET status = 'queued', lease_token = NULL, lease_until = NULL,
         last_error_code = 'lease_expired'
       WHERE slot = 'active' AND status = 'leased' AND lease_until <= now()`
    );
    const stalled = await client.query<{ id: string; lane_key: string }>(
      `SELECT id, lane_key
       FROM public.oos_drain_requests
       WHERE slot = 'active' AND status = 'queued'
         AND (last_error_code = 'lease_expired' OR updated_at <= now() - interval '5 minutes')
       ORDER BY updated_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [Math.max(1, Math.min(500, limit))]
    );
    let dispatched = 0;
    for (const request of stalled.rows) {
      const outcome = await enqueueRequestEvent(client, {
        id: request.id,
        laneKey: request.lane_key,
      });
      if (outcome === "dispatched") {
        dispatched++;
        continue;
      }
      if (outcome === "exhausted") {
        await client.query(
          `UPDATE public.oos_drain_requests
           SET status = 'failed', completed_at = now(), last_error_code = 'outbox_exhausted'
           WHERE id = $1 AND status = 'queued'`,
          [request.id]
        );
        const successor = await client.query<{ id: string }>(
          `UPDATE public.oos_drain_requests
           SET slot = 'active'
           WHERE id = (
             SELECT id FROM public.oos_drain_requests
             WHERE lane_key = $1 AND slot = 'successor' AND status = 'queued'
             ORDER BY created_at, id LIMIT 1 FOR UPDATE
           )
           RETURNING id`,
          [request.lane_key]
        );
        if (successor.rows[0]?.id) {
          const promoted = await enqueueRequestEvent(client, {
            id: successor.rows[0].id,
            laneKey: request.lane_key,
          });
          if (promoted === "dispatched") dispatched++;
        }
      }
    }
    await client.query("COMMIT");
    return dispatched;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
