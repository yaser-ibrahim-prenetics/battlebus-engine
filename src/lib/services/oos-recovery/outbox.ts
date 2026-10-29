import { getDatabasePool } from "@/lib/db/database";

export type OosOutboxEventName = "backorder/created" | "backorder/retry" | "oos/drain.requested";

export type ClaimedOosOutboxEntry = {
  id: string;
  eventId: string;
  eventName: OosOutboxEventName;
  eventData: Record<string, unknown>;
  attemptCount: number;
  leaseToken: string;
};

export function oosOutboxRetryDelaySeconds(attempt: number): number {
  return Math.min(21_600, 30 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
}

export async function claimOosOutboxEntries(
  limit: number,
  leaseSeconds: number,
  maxAttempts: number
): Promise<ClaimedOosOutboxEntry[]> {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("OOS outbox requires the configured PostgreSQL database");
  const result = await pool.query<{
    id: string;
    event_id: string;
    event_name: OosOutboxEventName;
    event_data: Record<string, unknown>;
    attempt_count: number;
    lease_token: string;
  }>(
    `WITH exhausted_candidates AS (
       SELECT id
       FROM public.oos_recovery_outbox
       WHERE status = 'leased' AND lease_until <= now() AND attempt_count >= $3
       ORDER BY lease_until, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ),
     exhausted AS (
       UPDATE public.oos_recovery_outbox AS outbox
       SET status = 'failed', next_attempt_at = 'infinity'::timestamptz,
         lease_token = NULL, lease_until = NULL,
         last_error_code = 'lease_attempts_exhausted'
       FROM exhausted_candidates
       WHERE outbox.id = exhausted_candidates.id
       RETURNING outbox.id
     ),
     candidates AS (
       SELECT id
       FROM public.oos_recovery_outbox
       WHERE attempt_count < $3
         AND ((status IN ('queued', 'failed') AND next_attempt_at <= now())
           OR (status = 'leased' AND lease_until <= now()))
       ORDER BY next_attempt_at, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.oos_recovery_outbox AS outbox
     SET status = 'leased',
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => $2),
         attempt_count = outbox.attempt_count + 1
     FROM candidates
     WHERE outbox.id = candidates.id
     RETURNING outbox.id, outbox.event_id, outbox.event_name, outbox.event_data,
       outbox.attempt_count, outbox.lease_token`,
    [
      Math.max(1, Math.min(500, limit)),
      Math.max(30, Math.min(1800, leaseSeconds)),
      Math.max(1, maxAttempts),
    ]
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventName: row.event_name,
    eventData: row.event_data,
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
  }));
}

export async function markOosOutboxPublished(entry: ClaimedOosOutboxEntry): Promise<boolean> {
  const pool = await getDatabasePool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE public.oos_recovery_outbox
     SET status = 'published', published_at = now(), lease_token = NULL, lease_until = NULL,
       last_error_code = NULL
     WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
    [entry.id, entry.leaseToken]
  );
  return result.rowCount === 1;
}

export async function markOosOutboxFailed(
  entry: ClaimedOosOutboxEntry,
  errorCode: string,
  maxAttempts: number
): Promise<"retryable" | "exhausted" | "stale"> {
  const pool = await getDatabasePool();
  if (!pool) return "stale";
  const exhausted = entry.attemptCount >= Math.max(1, maxAttempts);
  const result = await pool.query<{ status: "failed"; last_error_code: string }>(
    `UPDATE public.oos_recovery_outbox
     SET status = 'failed',
       next_attempt_at = CASE
         WHEN $3 THEN 'infinity'::timestamptz
         ELSE now() + make_interval(secs => $4)
       END,
       lease_token = NULL,
       lease_until = NULL,
       last_error_code = $5
     WHERE id = $1 AND status = 'leased' AND lease_token = $2
     RETURNING status, last_error_code`,
    [
      entry.id,
      entry.leaseToken,
      exhausted,
      oosOutboxRetryDelaySeconds(entry.attemptCount),
      errorCode.slice(0, 160),
    ]
  );
  if (result.rowCount !== 1) return "stale";
  return exhausted ? "exhausted" : "retryable";
}
