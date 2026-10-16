import { createHash } from "node:crypto";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { createWebhookInboxQueries } from "@/lib/db/queries/webhook-inbox";

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
  headers: Record<string, string | boolean>;
  events: WebhookInboxEvent[];
  schemaVersion: string;
  idempotencyKey?: string;
};

export type RecordedInboxEntry = {
  id: string;
  status: WebhookInboxStatus;
  duplicate: boolean;
};

export type ClaimedOutboxEvent = {
  id: string;
  inboxId: string;
  source: string;
  topic: string | null;
  schemaVersion: string;
  eventName: string;
  eventId: string | null;
  eventData: Record<string, unknown>;
  idempotencyKey: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  attempts: number;
  claimToken: string;
};

const queries = createWebhookInboxQueries(
  process.env.WEBHOOK_INBOX_TABLE || "webhook_inbox",
  process.env.EVENT_OUTBOX_TABLE || "event_outbox"
);

function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new Error("Durable webhook storage is not configured");
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findHeader(
  headers: Record<string, string | boolean>,
  names: readonly string[]
): string | undefined {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  for (const name of names) {
    const value = normalized.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractOrderReference(data: Record<string, unknown>): {
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
} {
  const nestedOrder =
    data.order && typeof data.order === "object"
      ? (data.order as Record<string, unknown>)
      : undefined;
  const id =
    data.shopifyOrderId ??
    data.shopify_order_id ??
    nestedOrder?.shopifyOrderId ??
    nestedOrder?.shopify_order_id ??
    nestedOrder?.id;
  const name =
    data.shopifyOrderName ??
    data.shopify_order_name ??
    data.orderName ??
    nestedOrder?.shopifyOrderName ??
    nestedOrder?.shopify_order_name ??
    nestedOrder?.name;

  return {
    shopifyOrderId: id == null ? null : String(id),
    shopifyOrderName: name == null ? null : String(name),
  };
}

function inboxIdempotencyKey(params: RecordInboxEntryParams, payloadHash: string): string {
  if (params.idempotencyKey?.trim()) return params.idempotencyKey.trim();
  return (
    findHeader(params.headers, [
      "x-shopify-webhook-id",
      "x-loop-webhook-id",
      "x-webhook-id",
      "idempotency-key",
    ]) ?? `${params.topic ?? "webhook"}:${payloadHash}`
  );
}

function mapClaimedRow(row: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: String(row.id),
    inboxId: String(row.inbox_id),
    source: String(row.source),
    topic: row.topic == null ? null : String(row.topic),
    schemaVersion: String(row.schema_version),
    eventName: String(row.event_name),
    eventId: row.event_id == null ? null : String(row.event_id),
    eventData: (row.event_data ?? {}) as Record<string, unknown>,
    idempotencyKey: String(row.idempotency_key),
    shopifyOrderId: row.shopify_order_id == null ? null : String(row.shopify_order_id),
    shopifyOrderName: row.shopify_order_name == null ? null : String(row.shopify_order_name),
    attempts: Number(row.attempts),
    claimToken: String(row.claim_token),
  };
}

export async function recordInboxEntry(
  params: RecordInboxEntryParams
): Promise<RecordedInboxEntry> {
  requireDatabase();
  const payloadJson = canonicalJson(params.payload ?? {});
  const payloadHash = sha256(payloadJson);
  const idempotencyKey = inboxIdempotencyKey(params, payloadHash);
  const durableEvents = params.events.map((event, index) => {
    const eventIdempotencyKey = event.id
      ? `${params.source}:event:${event.id}`
      : `${params.source}:${idempotencyKey}:${index}:${event.name}`;
    const order = extractOrderReference(event.data);
    return {
      event_name: event.name,
      event_id: event.id ?? sha256(eventIdempotencyKey),
      event_data: event.data,
      idempotency_key: eventIdempotencyKey,
      shopify_order_id: order.shopifyOrderId,
      shopify_order_name: order.shopifyOrderName,
    };
  });

  const result = await queryDatabase<{
    id: string;
    status: WebhookInboxStatus;
    payload_hash: string;
    duplicate_count: number;
  }>(queries.recordWithOutbox, [
    params.source,
    params.topic ?? null,
    payloadJson,
    JSON.stringify(params.headers ?? {}),
    JSON.stringify(params.events ?? []),
    idempotencyKey,
    params.schemaVersion,
    payloadHash,
    JSON.stringify(durableEvents),
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("Durable webhook receipt was not recorded");
  if (row.payload_hash !== payloadHash) {
    throw new Error(`Idempotency key ${idempotencyKey} was reused with a different payload`);
  }
  return {
    id: row.id,
    status: row.status,
    duplicate: Number(row.duplicate_count) > 0,
  };
}

export async function claimOutboxForInbox(
  inboxId: string,
  limit = 50,
  leaseSeconds = 120
): Promise<ClaimedOutboxEvent[]> {
  requireDatabase();
  const result = await queryDatabase(queries.claimForInbox, [
    inboxId,
    Math.max(1, limit),
    Math.max(30, leaseSeconds),
  ]);
  return result.rows.map((row) => mapClaimedRow(row));
}

export async function claimDueOutboxEvents(
  limit = 50,
  outboxId?: string,
  leaseSeconds = 120
): Promise<ClaimedOutboxEvent[]> {
  requireDatabase();
  const result = await queryDatabase(queries.claimDue, [
    Math.max(1, limit),
    outboxId ?? null,
    Math.max(30, leaseSeconds),
  ]);
  return result.rows.map((row) => mapClaimedRow(row));
}

export async function markOutboxPublished(entry: ClaimedOutboxEvent): Promise<void> {
  requireDatabase();
  const result = await queryDatabase<{ inbox_id: string }>(queries.markOutboxPublished, [
    entry.id,
    entry.claimToken,
  ]);
  if (result.rowCount !== 1) throw new Error(`Outbox claim ${entry.id} is no longer active`);
  await refreshInboxStatus(entry.inboxId);
}

export async function refreshInboxStatus(inboxId: string): Promise<WebhookInboxStatus> {
  requireDatabase();
  const result = await queryDatabase<{ status: WebhookInboxStatus }>(queries.refreshInboxStatus, [
    inboxId,
  ]);
  return result.rows[0]?.status ?? "received";
}

export async function markOutboxFailed(
  entry: ClaimedOutboxEvent,
  failure: {
    message: string;
    errorClass: string;
    recoveryAction: string;
    terminal: boolean;
    retryDelaySeconds: number;
  }
): Promise<"pending" | "dead_letter"> {
  requireDatabase();
  const result = await queryDatabase<{
    inbox_id: string;
    state: "pending" | "dead_letter";
  }>(queries.markOutboxFailed, [
    entry.id,
    entry.claimToken,
    failure.message,
    failure.errorClass,
    failure.terminal,
    Math.max(1, failure.retryDelaySeconds),
    failure.recoveryAction,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`Outbox claim ${entry.id} is no longer active`);
  await refreshInboxStatus(row.inbox_id);
  return row.state;
}

export async function requeueDeadLetter(outboxId: string): Promise<boolean> {
  requireDatabase();
  const result = await queryDatabase<{ inbox_id: string }>(queries.requeueDeadLetter, [outboxId]);
  const inboxId = result.rows[0]?.inbox_id;
  if (!inboxId) return false;
  await refreshInboxStatus(inboxId);
  return true;
}

export type DeadLetterSummary = {
  id: string;
  inboxId: string;
  source: string;
  topic: string | null;
  schemaVersion: string;
  eventName: string;
  eventId: string | null;
  idempotencyKey: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  attempts: number;
  lastError: string | null;
  errorClass: string | null;
  recoveryAction: string | null;
  deadLetteredAt: string;
};

export async function listDeadLetters(limit = 100): Promise<DeadLetterSummary[]> {
  requireDatabase();
  const result = await queryDatabase(queries.listDeadLetters, [Math.min(500, Math.max(1, limit))]);
  return result.rows.map((row) => ({
    id: String(row.id),
    inboxId: String(row.inbox_id),
    source: String(row.source),
    topic: row.topic == null ? null : String(row.topic),
    schemaVersion: String(row.schema_version),
    eventName: String(row.event_name),
    eventId: row.event_id == null ? null : String(row.event_id),
    idempotencyKey: String(row.idempotency_key),
    shopifyOrderId: row.shopify_order_id == null ? null : String(row.shopify_order_id),
    shopifyOrderName: row.shopify_order_name == null ? null : String(row.shopify_order_name),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    errorClass: row.error_class == null ? null : String(row.error_class),
    recoveryAction: row.recovery_action == null ? null : String(row.recovery_action),
    deadLetteredAt: String(row.dead_lettered_at),
  }));
}
