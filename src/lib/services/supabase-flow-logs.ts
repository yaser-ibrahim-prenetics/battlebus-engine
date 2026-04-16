/**
 * Supabase Flow Logs Drain — Buffered & Non-Blocking
 *
 * Writes structured flow/step/client log events to the `flow_logs` table.
 * Read by Battle Hub UI (Flow Logs page + per-order detail).
 *
 * Performance design:
 *   - Logs are buffered in memory and flushed in batches (default 25 rows or 2 s).
 *   - `logFlowEvent` never blocks the caller (fire-and-forget by default).
 *   - `logFlowEventSync` awaits the insert for critical error paths.
 *   - Retention pruning is done on a cooldown, never inline with inserts.
 *
 * Environment variables:
 *   FLOW_LOGS_ENABLED        – "false" to disable writes (default: enabled)
 *   FLOW_LOGS_TABLE          – table name (default: "flow_logs")
 *   FLOW_LOG_RETENTION_DAYS  – auto-prune rows older than N days (default: 30)
 *   FLOW_LOG_BATCH_SIZE      – max rows per flush (default: 25)
 *   FLOW_LOG_FLUSH_MS        – max ms before auto-flush (default: 2000)
 *   SUPABASE_URL             – Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY – service-role key for writes
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type FlowLogLevel = "info" | "warn" | "error";
type FlowLogStatus = "started" | "running" | "completed" | "failed" | "skipped";

export type FlowLogEvent = {
  level?: FlowLogLevel;
  flow: string;
  step?: string;
  client?: string;
  runId?: string;
  requestId?: string;
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  d365OrderNumber?: string;
  status?: FlowLogStatus | string;
  durationMs?: number;
  errorType?: string;
  errorMessage?: string;
  payload?: Record<string, unknown>;
};

let _client: SupabaseClient | null | undefined;
let _warnedMissingConfig = false;
let _lastPruneAt = 0;

const ENABLED = process.env.FLOW_LOGS_ENABLED !== "false";
const TABLE = process.env.FLOW_LOGS_TABLE || "flow_logs";
const RETENTION_DAYS = Math.max(
  1,
  Number.isFinite(Number(process.env.FLOW_LOG_RETENTION_DAYS))
    ? Number(process.env.FLOW_LOG_RETENTION_DAYS)
    : 30
);
const PRUNE_COOLDOWN_MS = 1000 * 60 * 60 * 6; // at most once per 6 hours per runtime

const _batchSizeParsed = parseInt(process.env.FLOW_LOG_BATCH_SIZE || "25", 10);
const BATCH_SIZE = Math.max(1, Number.isNaN(_batchSizeParsed) ? 25 : _batchSizeParsed);
const _flushMsParsed = parseInt(process.env.FLOW_LOG_FLUSH_MS || "2000", 10);
const FLUSH_INTERVAL_MS = Math.max(200, Number.isNaN(_flushMsParsed) ? 2000 : _flushMsParsed);

function getClient(): SupabaseClient | null {
  if (!ENABLED) return null;
  if (_client !== undefined) return _client;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  _client =
    url && key
      ? createClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;

  if (!_client && !_warnedMissingConfig) {
    _warnedMissingConfig = true;
    console.warn(
      "[FlowLogs] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing - flow logs drain disabled"
    );
  }

  return _client;
}

// ============================================================================
// Retention (decoupled from insert path)
// ============================================================================

async function pruneOldLogsIfDue(client: SupabaseClient): Promise<void> {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_COOLDOWN_MS) return;
  _lastPruneAt = now;

  const cutoffIso = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await client.from(TABLE).delete().lt("ts", cutoffIso);
  if (error) {
    console.warn(`[FlowLogs] Retention prune skipped: ${error.message}`);
  }
}

// ============================================================================
// Row builder
// ============================================================================

function eventToRow(event: FlowLogEvent): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level: event.level || "info",
    flow: event.flow,
    step: event.step || null,
    client: event.client || null,
    run_id: event.runId || null,
    request_id: event.requestId || null,
    shopify_order_id: event.shopifyOrderId || null,
    shopify_order_name: event.shopifyOrderName || null,
    d365_order_number: event.d365OrderNumber || null,
    status: event.status || null,
    duration_ms: typeof event.durationMs === "number" ? event.durationMs : null,
    error_type: event.errorType || null,
    error_message: event.errorMessage || null,
    payload: event.payload || {},
  };
}

// ============================================================================
// Buffer + flush
// ============================================================================

let _buffer: Record<string, unknown>[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _flushPromise: Promise<void> | null = null;

function scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void drainBuffer();
  }, FLUSH_INTERVAL_MS);
  // Prevent timer from keeping the process alive in serverless
  if (typeof _flushTimer === "object" && "unref" in _flushTimer) {
    (_flushTimer as NodeJS.Timeout).unref();
  }
}

async function drainBuffer(): Promise<void> {
  const client = getClient();
  if (!client || _buffer.length === 0) return;

  const batch = _buffer.splice(0, BATCH_SIZE);
  if (batch.length === 0) return;

  try {
    const { error } = await client.from(TABLE).insert(batch);
    if (error) {
      console.warn(`[FlowLogs] Batch insert (${batch.length} rows) failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FlowLogs] Unexpected batch error: ${msg}`);
  }

  // Trigger prune check (non-blocking, separate from insert)
  void pruneOldLogsIfDue(client);

  // Continue draining if there are more rows
  if (_buffer.length > 0) {
    scheduleFlush();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Non-blocking log: buffers the event and returns immediately.
 * Rows are flushed in batches (BATCH_SIZE rows or FLUSH_INTERVAL_MS, whichever first).
 */
export function logFlowEvent(event: FlowLogEvent): void {
  if (!ENABLED) return;

  _buffer.push(eventToRow(event));

  if (_buffer.length >= BATCH_SIZE) {
    // Flush immediately when batch is full
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    void drainBuffer();
  } else {
    scheduleFlush();
  }
}

/**
 * Blocking log: inserts the row immediately and awaits the result.
 * Use for critical error paths where the log must be persisted before the step throws.
 */
export async function logFlowEventSync(event: FlowLogEvent): Promise<void> {
  if (!ENABLED) return;

  // Flush any buffered rows first, then insert this one directly
  await flushAll();

  try {
    const client = getClient();
    if (!client) return;

    const { error } = await client.from(TABLE).insert(eventToRow(event));
    if (error) {
      console.warn(`[FlowLogs] Sync insert failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FlowLogs] Unexpected sync error: ${msg}`);
  }
}

/**
 * Flush all buffered rows. Call at the end of an Inngest step or before process exit.
 */
export async function flushAll(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }

  while (_buffer.length > 0) {
    await drainBuffer();
  }
  if (_flushPromise) await _flushPromise;
}
