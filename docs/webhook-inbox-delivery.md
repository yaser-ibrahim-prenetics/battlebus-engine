# Webhook inbox delivery reliability

This document describes PR 3 of the Spock Store replacement sequence. It hardens the durable
webhook receipt created after signature verification and before Inngest publication.

## Delivery contract

- Every persisted event has a stable event ID. Events without a stable ID fail closed before
  publication.
- A publisher claims a receipt with an exact UUID lease token and bounded expiry.
- Concurrent workers use `FOR UPDATE SKIP LOCKED` and receive disjoint receipts.
- Publication success or failure updates only the exact active lease token. A stale worker cannot
  acknowledge a newer claim.
- A crashed worker is recovered after the lease expires. If the expired attempt already reached
  the configured limit, it becomes a dead letter instead of running again.
- Retryable failures use bounded exponential backoff. Permanent HTTP 4xx failures, except 408,
  409, 425 and 429, dead-letter immediately.
- Raw provider errors, credentials, signatures and payload contents are not copied into
  `last_error`. Only a safe error category is retained.

The existing database `status` values remain backward-compatible. A non-null `lease_token`
represents active processing; a failed row with non-null `dead_lettered_at` represents a dead
letter.

## Configuration

| Variable                                 | Default |    Bounds | Purpose                        |
| ---------------------------------------- | ------: | --------: | ------------------------------ |
| `WEBHOOK_INBOX_DRAIN_INTERVAL_MINUTES`   |       5 |      1–59 | Scheduled sweep frequency      |
| `WEBHOOK_INBOX_CLAIM_BATCH_SIZE`         |      50 |     1–500 | Receipts claimed per sweep     |
| `WEBHOOK_INBOX_LEASE_SECONDS`            |     120 |    30–900 | Crash-recovery lease duration  |
| `WEBHOOK_INBOX_MAX_ATTEMPTS`             |      10 |     1–100 | Attempts before dead-lettering |
| `WEBHOOK_INBOX_RETRY_BASE_SECONDS`       |      60 |   1–3,600 | First retry delay              |
| `WEBHOOK_INBOX_RETRY_MAX_SECONDS`        |  21,600 | 60–86,400 | Maximum retry delay            |
| `WEBHOOK_INBOX_PUBLISHED_RETENTION_DAYS` |      30 |     1–365 | Published receipt retention    |
| `WEBHOOK_INBOX_RETENTION_BATCH_SIZE`     |     100 |   1–1,000 | Maximum deletions per sweep    |

When a claim fills the configured batch, the function emits one successor drain event. Backed-off,
leased and dead-letter rows are not selected by that successor, so a poison receipt cannot starve
newer work or create an unbounded retry loop.

## Dead-letter recovery

Dead letters are retained until an operator reviews them. They are visible in the authenticated
Battle Hub operations inbox view as `dead_letter`, with the safe error category, attempts and
terminal timestamp.

Replay uses the existing authenticated `replay_inbox` recovery command. The command records the
actor, reason and stable request ID before it:

1. Requeues only a terminal dead letter.
2. Increments `replay_count` and starts a fresh bounded attempt cycle.
3. Emits a targeted `webhook/inbox.drain` event.
4. Publishes and acknowledges through the same lease path as automatic delivery.

Active, backed-off or leased receipts cannot be manually replayed, preventing operator/drainer
races. Reuse the original recovery request ID when retrying an unchanged operator command.

## Retention

Only published receipts older than the configured retention period are deleted automatically.
Cleanup is oldest-first and bounded per transaction. Received, failed, leased and dead-letter rows
are never removed by retention. Dead letters therefore require an explicit reviewed replay before
they can become eligible for normal published retention.

## Deployment and rollback

1. Apply migration `000048_harden_webhook_inbox_delivery` before deploying the runtime.
2. Deploy the zero-traffic candidate and verify readiness before promotion.
3. Confirm the operations health view reports no unexpected dead letters or expired leases.
4. Keep stable event IDs unchanged across rollout; they are the protection if an old in-flight
   publisher loses its acknowledgement during promotion.

Before rolling back to a runtime older than PR 3, stop new webhook traffic and require this query to
return zero for both counters:

```sql
SELECT
  count(*) FILTER (WHERE lease_token IS NOT NULL) AS active_leases,
  count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letters
FROM public.webhook_inbox;
```

Resolve dead letters through the audited replay command and wait for active leases to settle before
rollback. Restore the old runtime before reversing migration 48. Migration reversal is not part of
normal Cloud Run rollback.
