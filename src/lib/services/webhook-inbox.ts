/**
 * PostgreSQL Webhook Inbox — durability layer for inbound webhooks.
 *
 * Every webhook route (Shopify, GPS, GPS individual, STORD, Loop, Dynamics
 * fulfilment) records the raw payload + intended Inngest event(s) here
 * immediately after signature verification, before attempting
 * `inngest.send()`. If the send fails (or the process crashes before it
 * runs), the row stays `received`/`failed` and is retried by the
 * `drain-webhook-inbox` cron (see src/inngest/functions/drain-webhook-inbox.ts).
 *
 * Mirrors the defensive style of flow-logs.ts: every call is
 * wrapped in try/catch and never throws to the caller. When PostgreSQL is
 * unconfigured, reads return empty results and writes are silently skipped
 * (logged via console.warn) — the webhook route still gets to decide
 * whether to fail the request based on the Inngest publish result itself.
 *
 * Environment variables:
 *   WEBHOOK_INBOX_TABLE       – table name (default: "webhook_inbox")
 */
import {
  isDatabaseConfigured,
  queryDatabase,
  quoteIdentifier,
} from "@/lib/db/database";

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

const TABLE = quoteIdentifier(process.env.WEBHOOK_INBOX_TABLE || "webhook_inbox");

let _warnedMissingConfig = false;

function databaseAvailable(): boolean {
  const available = isDatabaseConfigured();
  if (!available && !_warnedMissingConfig) {
    _warnedMissingConfig = true;
    console.warn("[WebhookInbox] PostgreSQL is not configured - webhook inbox disabled");
  }
  return available;
}

/**
 * Insert a `received` row for an inbound webhook. Must be awaited BEFORE
 * attempting to publish to Inngest — this is the durability guarantee.
 *
 * Returns the new row's id, or `null` if PostgreSQL is unconfigured or the
 * insert failed (never throws).
 */
export async function recordInboxEntry(params: RecordInboxEntryParams): Promise<string | null> {
  try {
    if (!databaseAvailable()) return null;
    const result = await queryDatabase<{ id: string }>(
      `INSERT INTO ${TABLE} (source, topic, payload, headers, events, status)
       VALUES ($1, $2, $3, $4, $5, 'received')
       RETURNING id`,
      [
        params.source,
        params.topic ?? null,
        params.payload ?? {},
        params.headers ?? {},
        params.events ?? [],
      ]
    );
    return result.rows[0]?.id ?? null;
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
    if (!databaseAvailable()) return;
    await queryDatabase(
      `UPDATE ${TABLE}
       SET status = 'published', published_at = now(), event_ids = $2
       WHERE id = $1`,
      [id, eventIds]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected markInboxPublished(${id}) error: ${msg}`);
  }
}

/** Mark a row as failed to publish (increments attempts). Never throws. */
export async function markInboxFailed(id: string, error: string): Promise<void> {
  if (!id) return;
  try {
    if (!databaseAvailable()) return;
    await queryDatabase(
      `UPDATE ${TABLE}
       SET status = 'failed', attempts = attempts + 1, last_error = $2
       WHERE id = $1`,
      [id, error]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected markInboxFailed(${id}) error: ${msg}`);
  }
}

/**
 * Fetch inbox rows not yet published, oldest first, for the drain cron to
 * re-attempt. Returns `[]` on any error or when PostgreSQL is unconfigured.
 */
export async function getUnpublishedInboxEntries(limit: number): Promise<UnpublishedInboxEntry[]> {
  try {
    if (!databaseAvailable()) return [];
    const result = await queryDatabase<{
      id: string;
      source: string;
      topic: string | null;
      events: WebhookInboxEvent[];
      attempts: number;
    }>(
      `SELECT id, source, topic, events, attempts
       FROM ${TABLE}
       WHERE status <> 'published'
       ORDER BY received_at ASC
       LIMIT $1`,
      [Math.max(1, limit)]
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      source: row.source as string,
      topic: (row.topic as string | null) ?? null,
      events: (row.events as WebhookInboxEvent[]) || [],
      attempts: row.attempts ?? 0,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WebhookInbox] Unexpected getUnpublishedInboxEntries error: ${msg}`);
    return [];
  }
}
