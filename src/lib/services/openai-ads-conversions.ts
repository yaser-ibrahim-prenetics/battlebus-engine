import { randomUUID } from "crypto";
import type { QueryResultRow } from "pg";

import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import { openAiAdsConversionQueries } from "@/lib/db/queries/openai-ads-conversions";

export type OpenAiAdsConversionState = "pending" | "delivering" | "delivered" | "dead_letter";

export interface OpenAiAdsConversionClaim {
  eventId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  occurredAt: string;
  attempts: number;
  claimToken: string;
}

interface StateRow extends QueryResultRow {
  event_id: string;
  state: OpenAiAdsConversionState;
}

interface ClaimRow extends QueryResultRow {
  event_id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  occurred_at: Date | string;
  attempts: number;
  claim_token: string;
}

function toConversionClaim(row: ClaimRow): OpenAiAdsConversionClaim {
  return {
    eventId: row.event_id,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderName: row.shopify_order_name,
    occurredAt:
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    attempts: row.attempts,
    claimToken: row.claim_token,
  };
}

function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new Error("Cloud SQL is required for durable OpenAI Ads conversion delivery");
  }
}

export function toOpenAiAdsEventId(shopifyOrderId: string | number): string {
  return `shopify_order_${shopifyOrderId}`;
}

export async function enqueueOpenAiAdsConversion({
  shopifyOrderId,
  shopifyOrderName,
  occurredAt,
}: {
  shopifyOrderId: string | number;
  shopifyOrderName: string;
  occurredAt: string;
}): Promise<{ eventId: string; state: OpenAiAdsConversionState }> {
  requireDatabase();
  const eventId = toOpenAiAdsEventId(shopifyOrderId);
  const inserted = await queryDatabase<StateRow>(openAiAdsConversionQueries.enqueue, [
    eventId,
    String(shopifyOrderId),
    shopifyOrderName,
    occurredAt,
  ]);
  const row = inserted.rows[0];
  if (row) return { eventId: row.event_id, state: row.state };

  const existing = await queryDatabase<StateRow>(openAiAdsConversionQueries.getByEventId, [
    eventId,
  ]);
  if (!existing.rows[0]) throw new Error(`OpenAI Ads conversion ${eventId} was not persisted`);
  return { eventId, state: existing.rows[0].state };
}

export async function claimOpenAiAdsConversions({
  eventId,
  limit = 25,
  leaseSeconds = 300,
  maxAttempts = 6,
}: {
  eventId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
} = {}): Promise<OpenAiAdsConversionClaim[]> {
  requireDatabase();
  const claimToken = randomUUID();
  const result = await queryDatabase<ClaimRow>(openAiAdsConversionQueries.claimDue, [
    Math.max(1, Math.min(limit, 100)),
    claimToken,
    Math.max(60, Math.min(leaseSeconds, 1800)),
    Math.max(1, maxAttempts),
    eventId || null,
  ]);
  return result.rows.map(toConversionClaim);
}

export async function claimOpenAiAdsConversionForRedelivery({
  eventId,
  leaseSeconds = 300,
}: {
  eventId: string;
  leaseSeconds?: number;
}): Promise<OpenAiAdsConversionClaim | null> {
  requireDatabase();
  const claimToken = randomUUID();
  const result = await queryDatabase<ClaimRow>(openAiAdsConversionQueries.claimForRedelivery, [
    eventId,
    claimToken,
    Math.max(60, Math.min(leaseSeconds, 1800)),
  ]);
  return result.rows[0] ? toConversionClaim(result.rows[0]) : null;
}

export async function markOpenAiAdsConversionDelivered({
  eventId,
  claimToken,
  httpStatus,
}: {
  eventId: string;
  claimToken: string;
  httpStatus: number;
}): Promise<void> {
  const result = await queryDatabase(openAiAdsConversionQueries.markDelivered, [
    eventId,
    claimToken,
    httpStatus,
  ]);
  if (result.rowCount !== 1) throw new Error(`OpenAI Ads conversion ${eventId} lost its claim`);
}

export async function markOpenAiAdsConversionFailed({
  eventId,
  claimToken,
  httpStatus,
  terminal,
  retryDelayMs,
  error,
}: {
  eventId: string;
  claimToken: string;
  httpStatus?: number;
  terminal: boolean;
  retryDelayMs: number;
  error: string;
}): Promise<void> {
  const result = await queryDatabase(openAiAdsConversionQueries.markFailed, [
    eventId,
    claimToken,
    httpStatus ?? null,
    terminal,
    Math.max(0, retryDelayMs),
    error,
  ]);
  if (result.rowCount !== 1) throw new Error(`OpenAI Ads conversion ${eventId} lost its claim`);
}
