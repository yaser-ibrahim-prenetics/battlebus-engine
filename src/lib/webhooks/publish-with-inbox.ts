// ============================================================================
// PUBLISH WEBHOOK EVENTS — durable inbox + best-effort Inngest publish
// ============================================================================
// Shared by every webhook route (Shopify, GPS, GPS individual, STORD, Loop,
// Dynamics fulfilment). Guarantees the inbound webhook is never silently
// lost if inngest.send() fails or throws:
//
//   1. Persist a payload fingerprint, allowlisted transport metadata and the
//      replay-required events to `webhook_inbox` BEFORE attempting to send.
//   2. Always attempt inngest.send() for the collected events.
//   3. Claim an exact expiring lease, publish stable event IDs, then
//      acknowledge only that lease and
//      return { published: true }.
//   4. On failure, schedule bounded backoff or dead-letter the receipt and return
//      { published: false } so the caller can respond with a 5xx — this lets
//      the webhook sender's own retry logic (e.g. Shopify retries non-2xx
//      webhooks for up to 48h) kick in. The `drain-webhook-inbox` cron is the
//      safety net for events that still never make it through.

import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import { isDatabaseConfigured } from "@/lib/db/database";
import {
  claimWebhookInboxEntry,
  classifyWebhookInboxDeliveryFailure,
  recordInboxEntry,
  markInboxPublished,
  markInboxFailed,
  validateWebhookInboxEvents,
  webhookInboxDeliveryMaxAttempts,
  webhookInboxDeliveryPolicy,
  type WebhookInboxEvent,
} from "@/lib/services/webhook-inbox";

/** Minimal non-secret transport metadata useful for receipt correlation. */
const PERSISTED_HEADER_NAMES = new Set([
  "content-type",
  "x-request-id",
  "x-shopify-topic",
  "x-shopify-webhook-id",
  "x-shopify-shop-domain",
  "x-timestamp",
]);

/**
 * Build an allowlisted, bounded metadata map for the inbox `headers` column.
 * Credentials, cookies, signatures and arbitrary provider headers are omitted.
 */
export function redactWebhookHeaders(
  headers: Record<string, string | null | undefined>
): Record<string, string | boolean> {
  const redacted: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (PERSISTED_HEADER_NAMES.has(lowerKey) && value != null) {
      redacted[lowerKey] = value.slice(0, 512);
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
  const databaseConfigured = isDatabaseConfigured();
  const inboxId = await recordInboxEntry({
    source,
    topic: topic ?? null,
    payload,
    headers: redactWebhookHeaders(headers),
    events,
  });

  if (databaseConfigured && !inboxId) {
    return { published: false, inboxId: null, error: "durable_receipt_unavailable" };
  }

  // Nothing to send (e.g. filtered/skipped topic) — trivially "published".
  if (events.length === 0) {
    return { published: true, eventIds: [], inboxId };
  }

  const eventValidationError = validateWebhookInboxEvents(events);

  const maxAttempts = webhookInboxDeliveryMaxAttempts(
    config.webhookInbox.durableDeliveryEnabled,
    config.webhookInbox.maxAttempts
  );
  const claimed = inboxId
    ? await claimWebhookInboxEntry(inboxId, {
        leaseSeconds: config.webhookInbox.leaseSeconds,
        maxAttempts,
      })
    : null;

  if (inboxId && !claimed) {
    return { published: false, inboxId, error: "durable_receipt_claim_unavailable" };
  }

  if (eventValidationError) {
    if (claimed) {
      await markInboxFailed(claimed, {
        errorCode: eventValidationError,
        maxAttempts,
        retryDelaySeconds: 1,
        terminal: true,
      });
    }
    return { published: false, inboxId, error: eventValidationError };
  }

  try {
    const sendResult = await inngest.send(events as Parameters<typeof inngest.send>[0]);
    const eventIds = sendResult?.ids ?? [];

    if (claimed) {
      const acknowledged = await markInboxPublished(claimed, eventIds);
      if (!acknowledged) {
        return { published: false, inboxId, error: "publication_acknowledgement_failed" };
      }
    }

    return { published: true, eventIds, inboxId };
  } catch (error) {
    const failure = classifyWebhookInboxDeliveryFailure(error);
    console.error(
      `[WebhookInbox] Failed to publish source=${source} category=${failure.errorCode}`
    );

    if (claimed) {
      const policy = webhookInboxDeliveryPolicy({
        durableDeliveryEnabled: config.webhookInbox.durableDeliveryEnabled,
        configuredMaxAttempts: config.webhookInbox.maxAttempts,
        attempt: claimed.attempts,
        retryBaseSeconds: config.webhookInbox.retryBaseSeconds,
        retryMaxSeconds: config.webhookInbox.retryMaxSeconds,
        terminalFailure: failure.terminal,
      });
      // Awaited: the caller needs the failure safely recorded before
      // deciding what status code to return.
      await markInboxFailed(claimed, {
        errorCode: failure.errorCode,
        ...policy,
      });
    }

    return { published: false, inboxId, error: failure.errorCode };
  }
}
