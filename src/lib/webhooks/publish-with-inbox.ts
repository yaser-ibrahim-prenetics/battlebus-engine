import { inngest } from "@/inngest/client";
import { classifyDeliveryError } from "@/lib/errors/delivery-error";
import {
  claimOutboxForInbox,
  markOutboxFailed,
  markOutboxPublished,
  recordInboxEntry,
  type WebhookInboxEvent,
} from "@/lib/services/webhook-inbox";
import {
  assertWebhookPayload,
  resolveWebhookSchemaVersion,
} from "@/lib/webhooks/schema-registry";

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

export function redactWebhookHeaders(
  headers: Record<string, string | null | undefined>
): Record<string, string | boolean> {
  const redacted: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
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
  idempotencyKey?: string;
};

export type PublishWebhookEventsResult =
  | { published: true; eventIds: string[]; inboxId: string }
  | { published: false; inboxId: string | null; error: string };

export async function publishWebhookEvents(
  params: PublishWebhookEventsParams
): Promise<PublishWebhookEventsResult> {
  let inboxId: string | null = null;
  try {
    const schemaVersion = resolveWebhookSchemaVersion(params.source, params.headers);
    assertWebhookPayload(params.payload, params.source, schemaVersion);
    const receipt = await recordInboxEntry({
      source: params.source,
      topic: params.topic ?? null,
      payload: params.payload,
      headers: redactWebhookHeaders(params.headers),
      events: params.events,
      schemaVersion,
      idempotencyKey: params.idempotencyKey,
    });
    inboxId = receipt.id;

    if (params.events.length === 0 || receipt.status === "published") {
      return { published: true, eventIds: [], inboxId };
    }

    const claimed = await claimOutboxForInbox(inboxId, params.events.length);
    if (claimed.length === 0) {
      return { published: true, eventIds: [], inboxId };
    }

    const eventIds: string[] = [];
    for (const entry of claimed) {
      try {
        const sendResult = await inngest.send([
          { name: entry.eventName, data: entry.eventData, id: entry.eventId ?? undefined },
        ] as Parameters<typeof inngest.send>[0]);
        eventIds.push(...(sendResult?.ids ?? []));
        await markOutboxPublished(entry);
      } catch (error) {
        await markOutboxFailed(entry, classifyDeliveryError(error, entry.attempts));
        throw error;
      }
    }

    return { published: true, eventIds, inboxId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebhookInbox] Failed durable publish for ${params.source}:`, error);
    return { published: false, inboxId, error: message };
  }
}
