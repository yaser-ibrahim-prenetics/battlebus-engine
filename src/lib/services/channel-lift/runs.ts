import type { QueryResultRow } from "pg";

import {
  ChannelLiftError,
  channelLiftRunId,
  validateReportingDate,
  type AttributionCounts,
  type ChannelLiftMode,
  type ChannelLiftSource,
} from "@/lib/channel-lift/model";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";
import {
  completeChannelLiftRunSQL,
  failChannelLiftRunSQL,
  insertChannelLiftRunSQL,
  readActiveChannelLiftRunSQL,
  readChannelLiftRunSQL,
  recordChannelLiftPreparedSQL,
  recordChannelLiftProgressSQL,
  startChannelLiftRunSQL,
} from "@/lib/sql/channel-lift/runs";

export type ChannelLiftRunStatus =
  | "queued"
  | "running"
  | "dry_run_completed"
  | "completed"
  | "failed";

export type ChannelLiftRun = {
  runId: string;
  reportingDate: string;
  mode: ChannelLiftMode;
  source: ChannelLiftSource;
  requestId: string;
  status: ChannelLiftRunStatus;
  attempts: number;
  expectedRows: number | null;
  expectedOrders: number | null;
  expectedPairs: number | null;
  mappedPairs: number | null;
  eligibleEvents: number | null;
  exclusionCounts: Record<string, number>;
  batchCount: number;
  attemptedEvents: number;
  deliveredEvents: number;
  configHash: string | null;
  snapshotHash: string | null;
  lastErrorCode: string | null;
  eligibilityCutoffSeconds: number;
};

type RunRow = QueryResultRow & {
  run_id: string;
  reporting_date: Date | string;
  mode: ChannelLiftMode;
  source: ChannelLiftSource;
  request_id: string;
  status: ChannelLiftRunStatus;
  attempts: number;
  expected_rows: number | null;
  expected_orders: number | null;
  expected_pairs: number | null;
  mapped_pairs: number | null;
  eligible_events: number | null;
  exclusion_counts: Record<string, number>;
  batch_count: number;
  attempted_events: number;
  delivered_events: number;
  config_hash: string | null;
  snapshot_hash: string | null;
  last_error_code: string | null;
  eligibility_cutoff_seconds: string | number;
};

function requireDatabase(): void {
  if (!isDatabaseConfigured()) {
    throw new Error("PostgreSQL is required for durable channel-lift delivery");
  }
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function asRun(row: RunRow): ChannelLiftRun {
  return {
    runId: row.run_id,
    reportingDate: dateOnly(row.reporting_date),
    mode: row.mode,
    source: row.source,
    requestId: row.request_id,
    status: row.status,
    attempts: Number(row.attempts),
    expectedRows: row.expected_rows === null ? null : Number(row.expected_rows),
    expectedOrders: row.expected_orders === null ? null : Number(row.expected_orders),
    expectedPairs: row.expected_pairs === null ? null : Number(row.expected_pairs),
    mappedPairs: row.mapped_pairs === null ? null : Number(row.mapped_pairs),
    eligibleEvents: row.eligible_events === null ? null : Number(row.eligible_events),
    exclusionCounts: row.exclusion_counts,
    batchCount: Number(row.batch_count),
    attemptedEvents: Number(row.attempted_events),
    deliveredEvents: Number(row.delivered_events),
    configHash: row.config_hash,
    snapshotHash: row.snapshot_hash,
    lastErrorCode: row.last_error_code,
    eligibilityCutoffSeconds: Number(row.eligibility_cutoff_seconds),
  };
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "channel_lift_failure";
}

export async function startChannelLiftRun({
  reportingDate: rawReportingDate,
  mode,
  source,
  requestId,
  requestedBy,
  requestReason,
}: {
  reportingDate: string;
  mode: ChannelLiftMode;
  source: ChannelLiftSource;
  requestId: string;
  requestedBy?: string;
  requestReason?: string;
}): Promise<{ disposition: "started" | "active" | "already_completed"; run: ChannelLiftRun }> {
  requireDatabase();
  const reportingDate = validateReportingDate(rawReportingDate);
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(requestId)) {
    throw new ChannelLiftError("request_id_invalid");
  }
  if (
    source === "manual" &&
    (!requestReason || requestReason.trim().length < 10 || requestReason.length > 1_000)
  ) {
    throw new ChannelLiftError("manual_request_reason_invalid");
  }
  const runId = channelLiftRunId(reportingDate, mode);
  try {
    const inserted = await queryDatabase(insertChannelLiftRunSQL, [
      runId,
      reportingDate,
      mode,
      source,
      requestId,
      requestedBy?.slice(0, 320) || null,
      source === "manual" ? requestReason?.slice(0, 1_000) || null : null,
    ]);
    if (inserted.rowCount === 0) {
      const existing = await queryDatabase<RunRow>(readChannelLiftRunSQL, [runId]);
      if (existing.rows[0]) {
        const run = asRun(existing.rows[0]);
        if (run.status === "queued" || run.status === "running") {
          return {
            disposition: run.requestId === requestId ? "started" : "active",
            run,
          };
        }
        if (run.status === "completed" || run.status === "dry_run_completed") {
          return { disposition: "already_completed", run };
        }
      }
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") {
      throw error;
    }
    const active = await queryDatabase<RunRow>(readActiveChannelLiftRunSQL, [reportingDate]);
    if (active.rows[0]) {
      const run = asRun(active.rows[0]);
      return {
        disposition: run.requestId === requestId ? "started" : "active",
        run,
      };
    }
    throw error;
  }

  const started = await queryDatabase<RunRow>(startChannelLiftRunSQL, [runId]);
  if (started.rows[0]) return { disposition: "started", run: asRun(started.rows[0]) };

  const existing = await queryDatabase<RunRow>(readChannelLiftRunSQL, [runId]);
  const row = existing.rows[0];
  if (!row) throw new Error("Channel-lift run reservation was not persisted");
  const run = asRun(row);
  return {
    disposition:
      run.status === "completed" || run.status === "dry_run_completed"
        ? "already_completed"
        : "active",
    run,
  };
}

export async function recordChannelLiftPrepared({
  runId,
  counts,
  mappedPairs,
  eligibleEvents,
  exclusionCounts,
  configHash,
  snapshotHash,
}: {
  runId: string;
  counts: AttributionCounts;
  mappedPairs: number;
  eligibleEvents: number;
  exclusionCounts: Record<string, number>;
  configHash: string;
  snapshotHash: string;
}): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(exclusionCounts), "utf8") > 8_000) {
    throw new ChannelLiftError("exclusion_counts_oversized");
  }
  const result = await queryDatabase(recordChannelLiftPreparedSQL, [
    runId,
    counts.rows,
    counts.orders,
    counts.pairs,
    mappedPairs,
    eligibleEvents,
    JSON.stringify(exclusionCounts),
    configHash,
    snapshotHash,
  ]);
  if (result.rowCount !== 1) throw new ChannelLiftError("prepared_snapshot_changed");
}

export async function recordChannelLiftProgress({
  runId,
  batchCount,
  attemptedEvents,
  deliveredEvents,
}: {
  runId: string;
  batchCount: number;
  attemptedEvents: number;
  deliveredEvents: number;
}): Promise<void> {
  const result = await queryDatabase(recordChannelLiftProgressSQL, [
    runId,
    batchCount,
    attemptedEvents,
    deliveredEvents,
  ]);
  if (result.rowCount !== 1) throw new Error("Channel-lift progress was not persisted");
}

export async function completeChannelLiftRun(runId: string, mode: ChannelLiftMode): Promise<void> {
  const targetStatus = mode === "live" ? "completed" : "dry_run_completed";
  const result = await queryDatabase(completeChannelLiftRunSQL, [
    runId,
    targetStatus,
  ]);
  if (result.rowCount === 1) return;
  const existing = await queryDatabase<RunRow>(readChannelLiftRunSQL, [runId]);
  if (existing.rows[0]?.status === targetStatus) return;
  throw new Error("Channel-lift completion was not persisted");
}

export async function failChannelLiftRun(runId: string, errorCode: string): Promise<void> {
  const code = safeErrorCode(errorCode);
  const result = await queryDatabase(failChannelLiftRunSQL, [runId, code]);
  if (result.rowCount === 1) return;
  const existing = await queryDatabase<RunRow>(readChannelLiftRunSQL, [runId]);
  if (existing.rows[0]?.status === "failed" && existing.rows[0].last_error_code === code) return;
  throw new Error("Channel-lift failure was not persisted");
}
