/**
 * PostgreSQL webhook inbox.
 *
 * A verified webhook is persisted before publication. Every publisher must
 * claim an exact, expiring lease before sending the recorded events and must
 * acknowledge that exact lease afterwards. Failed attempts use bounded
 * exponential backoff; exhausted rows become operator-visible dead letters.
 */
import { createHash } from "node:crypto";

import { isDatabaseConfigured, queryDatabase, quoteIdentifier } from "@/lib/db/database";
import { createClaimWebhookInboxEntriesSQL } from "@/lib/sql/webhook-inbox/claim";
import {
  createFailWebhookInboxEntrySQL,
  createPublishWebhookInboxEntrySQL,
  createRequeueWebhookInboxDeadLetterSQL,
} from "@/lib/sql/webhook-inbox/finish";
import { createDeleteRetainedWebhookInboxEntriesSQL } from "@/lib/sql/webhook-inbox/retention";

export type WebhookInboxStatus = "received" | "published" | "failed";

export type WebhookInboxEvent = {
  name: string;
  data: Record<string, unknown>;
  id: string;
};

export type RecordInboxEntryParams = {
  source: string;
  topic?: string | null;
  payload: unknown;
  headers: Record<string, string | boolean>;
  events: WebhookInboxEvent[];
};

export type ClaimedWebhookInboxEntry = {
  id: string;
  source: string;
  topic: string | null;
  events: WebhookInboxEvent[];
  attempts: number;
  replayCount: number;
  leaseToken: string;
  leaseExpiresAt: string;
};

export type ClaimWebhookInboxOptions = {
  leaseSeconds: number;
  maxAttempts: number;
  inboxId?: string;
};

export type WebhookInboxFailureState = "retryable" | "dead_letter" | "stale";

export type WebhookInboxDeliveryFailure = {
  errorCode: string;
  terminal: boolean;
};

export const WEBHOOK_INBOX_COMPATIBILITY_MAX_ATTEMPTS = 2_000_000_000;

export type WebhookInboxDeliveryPolicy = {
  maxAttempts: number;
  retryDelaySeconds: number;
  terminal: boolean;
};

export function webhookInboxDeliveryMaxAttempts(
  durableDeliveryEnabled: boolean,
  configuredMaxAttempts: number
): number {
  return durableDeliveryEnabled ? configuredMaxAttempts : WEBHOOK_INBOX_COMPATIBILITY_MAX_ATTEMPTS;
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*\/[a-zA-Z0-9_.-]+$/;

const tableName = process.env.WEBHOOK_INBOX_TABLE || "webhook_inbox";
const TABLE = quoteIdentifier(tableName);
const claimEntriesSQL = createClaimWebhookInboxEntriesSQL(tableName);
const publishEntrySQL = createPublishWebhookInboxEntrySQL(tableName);
const failEntrySQL = createFailWebhookInboxEntrySQL(tableName);
const requeueDeadLetterSQL = createRequeueWebhookInboxDeadLetterSQL(tableName);
const deleteRetainedEntriesSQL = createDeleteRetainedWebhookInboxEntriesSQL(tableName);

let warnedMissingConfig = false;

function databaseAvailable(): boolean {
  const available = isDatabaseConfigured();
  if (!available && !warnedMissingConfig) {
    warnedMissingConfig = true;
    console.warn("[WebhookInbox] PostgreSQL is not configured - webhook inbox disabled");
  }
  return available;
}

function errorCategory(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

export type WebhookPayloadFingerprint = {
  sha256: string;
  byteLength: number;
};

/** Persist only a content fingerprint; replay uses the separately minimized events. */
export function fingerprintWebhookPayload(payload: unknown): WebhookPayloadFingerprint {
  const serialized =
    typeof payload === "string" ? payload : (JSON.stringify(payload ?? null) ?? "null");
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    byteLength: Buffer.byteLength(serialized),
  };
}

/** Validate persisted events before any publication or replay side effect. */
export function validateWebhookInboxEvents(events: WebhookInboxEvent[]): string | null {
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return "invalid_event_batch";
  }
  for (const event of events) {
    if (
      !event ||
      typeof event.id !== "string" ||
      !event.id.trim() ||
      event.id.length > 512 ||
      typeof event.name !== "string" ||
      !EVENT_NAME_PATTERN.test(event.name) ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    ) {
      return "invalid_stable_event_identity";
    }
  }
  return null;
}

/** Bounded exponential retry delay: base, 2×base, 4×base, ... */
export function webhookInboxRetryDelaySeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number
): number {
  const base = Math.max(1, baseSeconds);
  const maximum = Math.max(base, maxSeconds);
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  return Math.min(maximum, base * 2 ** exponent);
}

/** Keep rollout-mode attempt, delay, and terminal-failure behavior in one policy. */
export function webhookInboxDeliveryPolicy(params: {
  durableDeliveryEnabled: boolean;
  configuredMaxAttempts: number;
  attempt: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  terminalFailure: boolean;
}): WebhookInboxDeliveryPolicy {
  return {
    maxAttempts: webhookInboxDeliveryMaxAttempts(
      params.durableDeliveryEnabled,
      params.configuredMaxAttempts
    ),
    retryDelaySeconds: params.durableDeliveryEnabled
      ? webhookInboxRetryDelaySeconds(
          params.attempt,
          params.retryBaseSeconds,
          params.retryMaxSeconds
        )
      : 1,
    terminal: params.durableDeliveryEnabled && params.terminalFailure,
  };
}

/** Keep persisted/logged delivery failures free of credentials and payloads. */
export function classifyWebhookInboxDeliveryFailure(error: unknown): WebhookInboxDeliveryFailure {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const statusValue = candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status;
  const status = Number.isInteger(Number(statusValue)) ? Number(statusValue) : undefined;
  const name =
    typeof candidate?.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.name)
      ? candidate.name
      : "delivery_error";
  const code =
    typeof candidate?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
      ? candidate.code
      : undefined;
  const errorCode = [name, code, status ? `http_${status}` : undefined].filter(Boolean).join(":");
  const terminal =
    status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
  return { errorCode, terminal };
}

function mapClaimedRow(row: {
  id: string;
  source: string;
  topic: string | null;
  events: WebhookInboxEvent[];
  attempts: number;
  replay_count: number;
  lease_token: string;
  lease_expires_at: Date | string;
}): ClaimedWebhookInboxEntry {
  return {
    id: row.id,
    source: row.source,
    topic: row.topic ?? null,
    events: row.events ?? [],
    attempts: Number(row.attempts),
    replayCount: Number(row.replay_count),
    leaseToken: row.lease_token,
    leaseExpiresAt:
      row.lease_expires_at instanceof Date
        ? row.lease_expires_at.toISOString()
        : String(row.lease_expires_at),
  };
}

/**
 * Insert a receipt before publication. Empty event lists are terminal at
 * insertion because there is deliberately nothing to publish.
 */
export async function recordInboxEntry(params: RecordInboxEntryParams): Promise<string | null> {
  try {
    if (!databaseAvailable()) return null;
    const published = params.events.length === 0;
    const result = await queryDatabase<{ id: string }>(
      `INSERT INTO ${TABLE} (
         source, topic, payload, headers, events, status, published_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         CASE WHEN $6 = 'published' THEN now() ELSE NULL END
       )
       RETURNING id`,
      [
        params.source,
        params.topic ?? null,
        fingerprintWebhookPayload(params.payload),
        params.headers ?? {},
        params.events ?? [],
        published ? "published" : "received",
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (error) {
    console.warn(
      `[WebhookInbox] Receipt insert failed for source=${params.source}: ${errorCategory(error)}`
    );
    return null;
  }
}

/** Claim ready rows atomically. Concurrent workers receive disjoint rows. */
export async function claimWebhookInboxEntries(
  limit: number,
  options: ClaimWebhookInboxOptions
): Promise<ClaimedWebhookInboxEntry[]> {
  try {
    if (!databaseAvailable()) return [];
    const result = await queryDatabase<{
      id: string;
      source: string;
      topic: string | null;
      events: WebhookInboxEvent[];
      attempts: number;
      replay_count: number;
      lease_token: string;
      lease_expires_at: Date | string;
    }>(claimEntriesSQL, [
      Math.max(1, limit),
      Math.max(30, options.leaseSeconds),
      Math.max(1, options.maxAttempts),
      options.inboxId ?? null,
    ]);
    return result.rows.map(mapClaimedRow);
  } catch (error) {
    console.warn(`[WebhookInbox] Claim failed: ${errorCategory(error)}`);
    return [];
  }
}

/** Claim one newly inserted or operator-requeued receipt by id. */
export async function claimWebhookInboxEntry(
  inboxId: string,
  options: Omit<ClaimWebhookInboxOptions, "inboxId">
): Promise<ClaimedWebhookInboxEntry | null> {
  const claimed = await claimWebhookInboxEntries(1, { ...options, inboxId });
  return claimed[0] ?? null;
}

/** Acknowledge only the exact active lease. */
export async function markInboxPublished(
  entry: Pick<ClaimedWebhookInboxEntry, "id" | "leaseToken">,
  eventIds: string[]
): Promise<boolean> {
  try {
    if (!databaseAvailable()) return false;
    const result = await queryDatabase(publishEntrySQL, [entry.id, entry.leaseToken, eventIds]);
    return result.rowCount === 1;
  } catch (error) {
    console.warn(
      `[WebhookInbox] Publication acknowledgement failed for ${entry.id}: ${errorCategory(error)}`
    );
    return false;
  }
}

/**
 * Fail only the exact active lease. The caller supplies the already bounded
 * retry delay. The database converts the attempt to a dead letter once the
 * attempt limit is reached or the failure is known to be terminal.
 */
export async function markInboxFailed(
  entry: Pick<ClaimedWebhookInboxEntry, "id" | "leaseToken">,
  failure: {
    errorCode: string;
    maxAttempts: number;
    retryDelaySeconds: number;
    terminal?: boolean;
  }
): Promise<WebhookInboxFailureState> {
  try {
    if (!databaseAvailable()) return "stale";
    const result = await queryDatabase<{ dead_lettered_at: Date | null }>(failEntrySQL, [
      entry.id,
      entry.leaseToken,
      failure.errorCode,
      Math.max(1, failure.maxAttempts),
      Math.max(1, failure.retryDelaySeconds),
      failure.terminal === true,
    ]);
    const row = result.rows[0];
    if (!row) return "stale";
    return row.dead_lettered_at ? "dead_letter" : "retryable";
  } catch (error) {
    console.warn(
      `[WebhookInbox] Failure acknowledgement failed for ${entry.id}: ${errorCategory(error)}`
    );
    return "stale";
  }
}

/** Requeue one terminal dead letter exactly once per audited recovery command. */
export async function requeueWebhookInboxDeadLetter(
  inboxId: string,
  recoveryRequestId: string
): Promise<boolean> {
  try {
    if (!databaseAvailable()) return false;
    const result = await queryDatabase(requeueDeadLetterSQL, [inboxId, recoveryRequestId]);
    return result.rowCount === 1;
  } catch (error) {
    console.warn(`[WebhookInbox] Dead-letter replay failed: ${errorCategory(error)}`);
    return false;
  }
}

/** Delete only old published receipts, in a bounded batch. */
export async function deleteRetainedPublishedInboxEntries(
  retentionDays: number,
  limit: number
): Promise<number> {
  try {
    if (!databaseAvailable()) return 0;
    const result = await queryDatabase(deleteRetainedEntriesSQL, [
      Math.max(1, retentionDays),
      Math.max(1, limit),
    ]);
    return result.rowCount ?? 0;
  } catch (error) {
    console.warn(`[WebhookInbox] Retention cleanup failed: ${errorCategory(error)}`);
    return 0;
  }
}
