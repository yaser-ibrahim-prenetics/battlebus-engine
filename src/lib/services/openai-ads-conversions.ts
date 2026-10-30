import { createHash, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import { openAiAdsConfigurationIssue } from "@/lib/clients/openai-ads";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { openAiAdsConversionQueries } from "@/lib/db/queries/openai-ads-conversions";

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

export function toOpenAiAdsEventId(shopifyStore: string, shopifyOrderId: string | number): string {
  const identity = JSON.stringify([
    shopifyStore.trim().toLowerCase(),
    String(shopifyOrderId),
    "order_created",
  ]);
  return `bb_order_created_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
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
  requireDatabase();
  const store = shopifyStore.trim().toLowerCase();
  const orderId = String(shopifyOrderId);
  if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(store)) {
    throw new Error("OpenAI Ads conversion store identity is invalid");
  }
  if (!/^\d{1,20}$/.test(orderId)) {
    throw new Error("OpenAI Ads conversion order identity is invalid");
  }
  const parsedAt = Date.parse(occurredAt);
  if (!occurredAt || Number.isNaN(parsedAt)) {
    throw new Error("OpenAI Ads conversion timestamp is invalid");
  }

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
}): Promise<OpenAiAdsConversionStatus> {
  const result = await queryDatabase<{ status: OpenAiAdsConversionStatus }>(
    openAiAdsConversionQueries.markFailed,
    [
      eventId,
      leaseToken,
      httpStatus ?? null,
      terminal,
      Math.max(0, Math.floor(retryDelaySeconds)),
      category,
      error.slice(0, 1000),
    ]
  );
  if (result.rowCount !== 1) throw new Error("OpenAI Ads conversion claim was lost");
  return result.rows[0].status;
}
