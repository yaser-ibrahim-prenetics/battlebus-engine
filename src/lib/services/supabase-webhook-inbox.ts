/**
 * Supabase Webhook Inbox — durability layer for inbound webhooks.
 *
 * Every webhook route (Shopify, GPS, GPS individual, STORD, Loop, Dynamics
 * fulfilment) records the raw payload + intended Inngest event(s) here
 * immediately after signature verification, before attempting
 * `inngest.send()`. If the send fails (or the process crashes before it
 * runs), the row stays `received`/`failed` and is retried by the
 * `drain-webhook-inbox` cron (see src/inngest/functions/drain-webhook-inbox.ts).
 *
 * Mirrors the defensive style of supabase-flow-logs.ts: every call is
 * wrapped in try/catch and never throws to the caller. When Supabase is
 * unconfigured, reads return empty results and writes are silently skipped
 * (logged via console.warn) — the webhook route still gets to decide
 * whether to fail the request based on the Inngest publish result itself.
 *
 * Environment variables:
 *   SUPABASE_URL              – Supabase project URL (shared with flow logs)
 *   SUPABASE_SERVICE_ROLE_KEY – service-role key for writes (shared with flow logs)
 *   WEBHOOK_INBOX_TABLE       – table name (default: "webhook_inbox")
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type WebhookInboxStatus = "received" | "published" | "failed";

export type WebhookInboxEvent = {
  name: string;
  data: Record<string, unknown>;
  id?: string;
};

export type RecordInboxEntryParams = {
  source: string;
  topic?: string | null;
  payload: unknown;
  headers: Record<string, string>;
  events: WebhookInboxEvent[];
};

export type UnpublishedInboxEntry = {
  id: string;
  source: string;
  topic: string | null;
  events: WebhookInboxEvent[];
  attempts: number;
};

const TABLE = process.env.WEBHOOK_INBOX_TABLE || "webhook_inbox";

let _client: SupabaseClient | null | undefined;
let _warnedMissingConfig = false;

function getClient(): SupabaseClient | null {
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
      "[WebhookInbox] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing - webhook inbox disabled"
    );
  }

  return _client;
}

/**
 * Insert a `received` row for an inbound webhook. Must be awaited BEFORE
 * attempting to publish to Inngest — this is the durability guarantee.
 *
 * Returns the new row's id, or `null` if Supabase is unconfigured or the
 * insert failed (never throws).
 */
export async function recordInboxEntry(params: RecordInboxEntryParams): Promise<string | null> {
  try {
    const client = getClient();
    if (!client) return null;

    const { data, error } = await client
      .from(TABLE)
      .insert({
        source: params.source,
        topic: params.topic ?? null,
        payload: params.payload ?? {},
        headers: params.headers ?? {},
        events: params.events ?? [],
        status: "received",
      })
      .select("id")
      .single();

    if (error) {
      console.warn(`[WebhookInbox] Insert failed for source=${params.source}: ${error.message}`);
      return null;
    }

    return (data?.id as string) ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected insert error for source=${params.source}: ${msg}`);
    return null;
  }
}

/** Mark a row as successfully published to Inngest. Never throws. */
export async function markInboxPublished(id: string, eventIds: string[]): Promise<void> {
  if (!id) return;
  try {
    const client = getClient();
    if (!client) return;

    const { error } = await client
      .from(TABLE)
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        event_ids: eventIds,
      })
      .eq("id", id);

    if (error) {
      console.warn(`[WebhookInbox] markInboxPublished(${id}) failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected markInboxPublished(${id}) error: ${msg}`);
  }
}

/** Mark a row as failed to publish (increments attempts). Never throws. */
export async function markInboxFailed(id: string, error: string): Promise<void> {
  if (!id) return;
  try {
    const client = getClient();
    if (!client) return;

    // Read current attempts first — best-effort increment (low write volume, no RPC needed).
    const { data: current, error: selectError } = await client
      .from(TABLE)
      .select("attempts")
      .eq("id", id)
      .single();

    if (selectError) {
      console.warn(`[WebhookInbox] markInboxFailed(${id}) select failed: ${selectError.message}`);
    }

    const attempts = (current?.attempts as number | undefined) ?? 0;

    const { error: updateError } = await client
      .from(TABLE)
      .update({
        status: "failed",
        attempts: attempts + 1,
        last_error: error,
      })
      .eq("id", id);

    if (updateError) {
      console.warn(`[WebhookInbox] markInboxFailed(${id}) update failed: ${updateError.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected markInboxFailed(${id}) error: ${msg}`);
  }
}

/**
 * Fetch inbox rows not yet published, oldest first, for the drain cron to
 * re-attempt. Returns `[]` on any error or when Supabase is unconfigured.
 */
export async function getUnpublishedInboxEntries(limit: number): Promise<UnpublishedInboxEntry[]> {
  try {
    const client = getClient();
    if (!client) return [];

    const { data, error } = await client
      .from(TABLE)
      .select("id, source, topic, events, attempts")
      .neq("status", "published")
      .order("received_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.warn(`[WebhookInbox] getUnpublishedInboxEntries failed: ${error.message}`);
      return [];
    }

    return (data || []).map((row: any) => ({
      id: row.id as string,
      source: row.source as string,
      topic: (row.topic as string | null) ?? null,
      events: (row.events as WebhookInboxEvent[]) || [],
      attempts: (row.attempts as number) ?? 0,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected getUnpublishedInboxEntries error: ${msg}`);
    return [];
  }
}
