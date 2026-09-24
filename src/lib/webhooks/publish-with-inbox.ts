// ============================================================================
// PUBLISH WEBHOOK EVENTS — durable inbox + best-effort Inngest publish
// ============================================================================
// Shared by every webhook route (Shopify, GPS, GPS individual, STORD, Loop,
// Dynamics fulfilment). Guarantees the inbound webhook is never silently
// lost if inngest.send() fails or throws:
//
//   1. Persist the webhook (payload + intended events) to the `webhook_inbox`
//      table BEFORE attempting to send — this is awaited, so it happens even
//      if the process crashes immediately after.
//   2. Always attempt inngest.send() for the collected events.
//   3. On success, mark the inbox row `published` (fire-and-forget) and
//      return { published: true }.
//   4. On failure, mark the inbox row `failed` (awaited) and return
//      { published: false } so the caller can respond with a 5xx — this lets
//      the webhook sender's own retry logic (e.g. Shopify retries non-2xx
//      webhooks for up to 48h) kick in. The `drain-webhook-inbox` cron is the
//      safety net for events that still never make it through.

import { inngest } from "@/inngest/client";
import {
  recordInboxEntry,
  markInboxPublished,
  markInboxFailed,
  type WebhookInboxEvent,
} from "@/lib/services/supabase-webhook-inbox";

/** Header names whose values must never be persisted verbatim. */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "apikey",
  "api-key",
  "x-shopify-hmac-sha256",
  "x-signature",
  "x-loop-signature",
  "x-battle-bus-signature",
  "cookie",
  "set-cookie",
]);

/**
 * Build a redacted headers map safe to persist in the inbox `headers` jsonb
 * column: sensitive header values are replaced with a boolean presence flag,
 * everything else is passed through as-is.
 */
export function redactWebhookHeaders(
  headers: Record<string, string | null | undefined>
): Record<string, string | boolean> {
  const redacted: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lowerKey)) {
      redacted[key] = Boolean(value);
    } else if (value != null) {
      redacted[key] = value;
    }
  }
  return redacted;
}

export type PublishWebhookEventsParams = {
  source: string;
  topic?: string | null;
  payload: unknown;
  headers: Record<string, string | null | undefined>;
  events: WebhookInboxEvent[];
};

export type PublishWebhookEventsResult =
  | { published: true; eventIds: string[]; inboxId: string | null }
  | { published: false; inboxId: string | null; error: string };

/**
 * Durably record the inbound webhook, then attempt to publish its event(s)
 * to Inngest. Never throws — failures are captured and returned in the
 * result so the caller can decide the HTTP response.
 */
export async function publishWebhookEvents(
  params: PublishWebhookEventsParams
): Promise<PublishWebhookEventsResult> {
  const { source, topic, payload, headers, events } = params;

  // 1. Durability guarantee: persist before we ever attempt to send.
  const inboxId = await recordInboxEntry({
    source,
    topic: topic ?? null,
    payload,
    headers: redactWebhookHeaders(headers) as Record<string, string>,
    events,
  });

  // Nothing to send (e.g. filtered/skipped topic) — trivially "published".
  if (events.length === 0) {
    if (inboxId) {
      void markInboxPublished(inboxId, []);
    }
    return { published: true, eventIds: [], inboxId };
  }

  try {
    const sendResult = await inngest.send(events as Parameters<typeof inngest.send>[0]);
    const eventIds = sendResult?.ids ?? [];

    if (inboxId) {
      // Fire-and-forget: the send already succeeded, this is just bookkeeping.
      void markInboxPublished(inboxId, eventIds);
    }

    return { published: true, eventIds, inboxId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebhookInbox] Failed to publish ${source} event(s) to Inngest:`, error);

    if (inboxId) {
      // Awaited: the caller needs the failure safely recorded before
      // deciding what status code to return.
      await markInboxFailed(inboxId, message);
    }

    return { published: false, inboxId, error: message };
  }
}
