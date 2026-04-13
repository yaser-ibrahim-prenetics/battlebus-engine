/**
 * Supabase Flow Logs Drain
 *
 * Writes structured flow/step/client log events to the `flow_logs` table.
 * Read by Battle Hub UI (Flow Logs page + per-order detail).
 *
 * Environment variables:
 *   FLOW_LOGS_ENABLED        – "false" to disable writes (default: enabled)
 *   FLOW_LOGS_TABLE          – table name (default: "flow_logs")
 *   FLOW_LOG_RETENTION_DAYS  – auto-prune rows older than N days (default: 30)
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

export async function logFlowEvent(event: FlowLogEvent): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;

    void pruneOldLogsIfDue(client);

    const row = {
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

    const { error } = await client.from(TABLE).insert(row);
    if (error) {
      console.warn(`[FlowLogs] Insert failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FlowLogs] Unexpected logger error: ${msg}`);
  }
}
