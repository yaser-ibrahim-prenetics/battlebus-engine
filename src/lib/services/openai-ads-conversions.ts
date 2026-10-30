import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import { openAiAdsConfigurationIssue } from "@/lib/clients/openai-ads";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { openAiAdsConversionQueries } from "@/lib/db/queries/openai-ads-conversions";
import {
  normalizeOpenAiAdsShopifyStore,
  toOpenAiAdsEventId,
} from "@/lib/helpers/openai-ads-identity";

export {
  normalizeOpenAiAdsShopifyStore,
  toOpenAiAdsEventId,
} from "@/lib/helpers/openai-ads-identity";

export const OPENAI_ADS_MAX_ATTEMPTS = 6;
export const OPENAI_ADS_RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 14_400] as const;

export type OpenAiAdsConversionStatus =
  | "queued"
  | "delivering"
  | "retry_wait"
  | "delivered"
  | "permanent_failure"
  | "skipped";

export interface OpenAiAdsConversionSummary {
  eventId: string;
  status: OpenAiAdsConversionStatus;
  attempts: number;
  reason: string | null;
}

export interface OpenAiAdsConversionClaim {
  eventId: string;
  shopifyStore: string;
  shopifyOrderId: string;
  occurredAt: string;
  attempts: number;
  leaseToken: string;
  leaseUntil: string;
}

interface SummaryRow extends QueryResultRow {
  event_id: string;
  status: OpenAiAdsConversionStatus;
  attempts: number;
  last_error_category: string | null;
}

interface ClaimRow extends QueryResultRow {
  event_id: string;
  shopify_store: string;
  shopify_order_id: string;
  occurred_at: Date | string;
  attempts: number;
  lease_token: string;
  lease_until: Date | string;
}

interface FailureRow extends QueryResultRow {
  status: Extract<OpenAiAdsConversionStatus, "retry_wait" | "permanent_failure">;
  next_attempt_at: Date | string;
}

export class OpenAiAdsConversionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiAdsConversionValidationError";
  }
}

export type OpenAiAdsFailureTransition = {
  status: FailureRow["status"];
  nextAttemptAt: string | null;
};

function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new Error("PostgreSQL is required for durable OpenAI Ads conversion delivery");
  }
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summary(row: SummaryRow): OpenAiAdsConversionSummary {
  return {
    eventId: row.event_id,
    status: row.status,
    attempts: Number(row.attempts),
    reason: row.last_error_category,
  };
}

export function openAiAdsRetryDelaySeconds(attempt: number): number {
  return OPENAI_ADS_RETRY_DELAYS_SECONDS[Math.max(0, attempt - 1)] ?? 0;
}

export async function enqueueOpenAiAdsConversion({
  shopifyStore,
  shopifyOrderId,
  occurredAt,
}: {
  shopifyStore: string;
  shopifyOrderId: string | number;
  occurredAt: string;
}): Promise<OpenAiAdsConversionSummary> {
  const store = normalizeOpenAiAdsShopifyStore(shopifyStore);
  const orderId = String(shopifyOrderId);
  if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(store)) {
    throw new OpenAiAdsConversionValidationError(
      "OpenAI Ads conversion store identity is invalid"
    );
  }
  if (!/^\d{1,20}$/.test(orderId)) {
    throw new OpenAiAdsConversionValidationError(
      "OpenAI Ads conversion order identity is invalid"
    );
  }
  const parsedAt = Date.parse(occurredAt);
  if (!occurredAt || Number.isNaN(parsedAt)) {
    throw new OpenAiAdsConversionValidationError("OpenAI Ads conversion timestamp is invalid");
  }
  requireDatabase();

  const eventId = toOpenAiAdsEventId(store, orderId);
  const issue = openAiAdsConfigurationIssue(store);
  const status: OpenAiAdsConversionStatus = issue ? "skipped" : "queued";
  const inserted = await queryDatabase<SummaryRow>(openAiAdsConversionQueries.enqueue, [
    eventId,
    store,
    orderId,
    new Date(parsedAt).toISOString(),
    status,
    issue,
    issue ? new Date().toISOString() : null,
  ]);
  if (inserted.rows[0]) return summary(inserted.rows[0]);

  const existing = await queryDatabase<SummaryRow>(openAiAdsConversionQueries.getByIdentity, [
    store,
    orderId,
  ]);
  if (!existing.rows[0]) {
    throw new Error("OpenAI Ads conversion was not persisted");
  }
  return summary(existing.rows[0]);
}

export async function claimOpenAiAdsConversions({
  limit = 25,
  leaseSeconds = 120,
}: {
  limit?: number;
  leaseSeconds?: number;
} = {}): Promise<OpenAiAdsConversionClaim[]> {
  requireDatabase();
  const leaseToken = randomUUID();
  const result = await queryDatabase<ClaimRow>(openAiAdsConversionQueries.claimDue, [
    Math.max(1, Math.min(Math.floor(limit), 100)),
    leaseToken,
    Math.max(30, Math.min(Math.floor(leaseSeconds), 900)),
    OPENAI_ADS_MAX_ATTEMPTS,
  ]);
  return result.rows.map((row) => ({
    eventId: row.event_id,
    shopifyStore: row.shopify_store,
    shopifyOrderId: row.shopify_order_id,
    occurredAt: asIsoString(row.occurred_at),
    attempts: Number(row.attempts),
    leaseToken: row.lease_token,
    leaseUntil: asIsoString(row.lease_until),
  }));
}

export async function renewOpenAiAdsConversionClaim(
  claim: Pick<OpenAiAdsConversionClaim, "eventId" | "leaseToken">,
  leaseSeconds = 120
): Promise<boolean> {
  const result = await queryDatabase(openAiAdsConversionQueries.renewClaim, [
    claim.eventId,
    claim.leaseToken,
    Math.max(30, Math.min(Math.floor(leaseSeconds), 900)),
  ]);
  return result.rowCount === 1;
}

export async function markOpenAiAdsConversionDelivered({
  eventId,
  leaseToken,
  httpStatus,
}: {
  eventId: string;
  leaseToken: string;
  httpStatus: number;
}): Promise<void> {
  const result = await queryDatabase(openAiAdsConversionQueries.markDelivered, [
    eventId,
    leaseToken,
    httpStatus,
  ]);
  if (result.rowCount !== 1) throw new Error("OpenAI Ads conversion claim was lost");
}

export async function markOpenAiAdsConversionSkipped({
  eventId,
  leaseToken,
  category,
  reason,
}: {
  eventId: string;
  leaseToken: string;
  category: string;
  reason: string;
}): Promise<void> {
  const result = await queryDatabase(openAiAdsConversionQueries.markSkipped, [
    eventId,
    leaseToken,
    category,
    reason.slice(0, 1000),
  ]);
  if (result.rowCount !== 1) throw new Error("OpenAI Ads conversion claim was lost");
}

export async function markOpenAiAdsConversionFailed({
  eventId,
  leaseToken,
  httpStatus,
  terminal,
  retryDelaySeconds,
  category,
  error,
}: {
  eventId: string;
  leaseToken: string;
  httpStatus?: number;
  terminal: boolean;
  retryDelaySeconds: number;
  category: string;
  error: string;
}): Promise<OpenAiAdsFailureTransition> {
  const result = await queryDatabase<FailureRow>(openAiAdsConversionQueries.markFailed, [
    eventId,
    leaseToken,
    httpStatus ?? null,
    terminal,
    Math.max(0, Math.floor(retryDelaySeconds)),
    category,
    error.slice(0, 1000),
  ]);
  if (result.rowCount !== 1) throw new Error("OpenAI Ads conversion claim was lost");
  const row = result.rows[0];
  return {
    status: row.status,
    nextAttemptAt: row.status === "retry_wait" ? asIsoString(row.next_attempt_at) : null,
  };
}
