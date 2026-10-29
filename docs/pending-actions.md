# Pending Lifecycle Actions

## Purpose

Shopify can send fulfillment or cancellation events before Battle Bus has created the required D365 or GPS record. Battle Bus persists those actions and replays them after the downstream record can be addressed instead of silently losing the lifecycle change.

## Durable queue contract

`public.pending_lifecycle_actions` is the source of truth. Each row has:

- a stable `action_id`, reused as the Inngest event ID on every publication attempt;
- a producer `source_event_id`, deduplicated with `order_id` and `action_type`;
- the canonical event name and data;
- a generated priority: cancel, refund, then fulfill;
- queue status, attempt count, availability time, and version;
- a lease token and expiry while a worker owns the action; and
- terminal publication, supersession, or dead-letter state.

The runtime database role can select, insert, and update queue rows. It cannot delete them. Anonymous and authenticated application roles cannot read the table.

## Processing flow

```text
Shopify event
  -> lifecycle handler cannot address D365/GPS record
  -> enqueue with original Inngest event ID
  -> PostgreSQL deduplicates the producer retry

Scheduled drain
  -> import valid legacy JSON actions under row locks
  -> supersede fulfillment when cancellation is pending
  -> claim a bounded batch with FOR UPDATE SKIP LOCKED
  -> assign a time-limited lease
  -> batch-publish events using pending-action-<action_id>
  -> acknowledge each exact action_id + lease_token
```

If publication is uncertain, the claimed rows return to the queue with exponential backoff. If acknowledgement fails after publication, the lease expires and another worker republishes the same stable event ID. That provides at-least-once delivery without creating a new downstream identity.

## Cancellation priority

A queued or expired fulfillment is marked `superseded` when the same order has an active or published cancellation. Claim selection also excludes conflicting fulfillment rows, so a backlog larger than one sweep cannot bypass the rule.

An already active, unexpired fulfillment lease is not stolen. This keeps lease ownership correct; downstream handlers must remain idempotent for the narrow cancellation-versus-publication race.

## Legacy rollout bridge

`orders.pending_actions` remains during the expand phase so older Battle Bus or Battle Hub revisions can finish a rolling deployment safely. Before each claim, the drain:

1. locks a bounded set of order rows with non-empty, fully valid JSON action arrays;
2. inserts each action into the normalized queue with a deterministic legacy source ID; and
3. clears exactly those locked arrays in the same SQL statement.

A concurrent legacy append waits for the row lock and remains in the array for the next sweep. Malformed arrays are not cleared, preventing silent loss. Remove the bridge and legacy column only after all writers and operator views use the normalized table.

## Configuration

| Variable                                    | Default | Range  | Purpose                              |
| ------------------------------------------- | ------: | ------ | ------------------------------------ |
| `PENDING_ACTIONS_DRAIN_INTERVAL_MINUTES`    |      10 | 1-59   | Scheduled sweep interval             |
| `PENDING_ACTIONS_CLAIM_BATCH_SIZE`          |     100 | 1-500  | Maximum actions claimed per sweep    |
| `PENDING_ACTIONS_LEASE_SECONDS`             |     120 | 30-900 | Claim ownership window               |
| `PENDING_ACTIONS_MAX_ATTEMPTS`              |      10 | 1-100  | Attempts before dead-letter state    |
| `PENDING_ACTIONS_LEGACY_IMPORT_ORDER_LIMIT` |     100 | 1-500  | Legacy order rows imported per sweep |

These are non-secret runtime settings. The defaults are appropriate for the current Cloud Run and Cloud SQL footprint.

## Operational checks

- A successful enqueue returns an `action_id`; a repeated producer event returns the same ID.
- `publishing` rows always have a lease token and expiry.
- `published` rows have `published_at`; `superseded` rows have `superseded_at`.
- `dead_letter` rows require operator investigation and replay tooling before cutover.
- An elevated count of expired publishing leases indicates publication or database acknowledgement failures.
- Non-empty legacy arrays after several sweeps indicate malformed payloads or a legacy writer that is still active.

## Files

| File                                                   | Responsibility                                     |
| ------------------------------------------------------ | -------------------------------------------------- |
| `db/migrations/000040_*` through `000042_*`            | Queue schema, indexes, access policy, and rollback |
| `src/lib/services/pending-actions.ts`                  | Validation, enqueue, claim, acknowledgement, retry |
| `src/lib/sql/pending-actions/`                         | Atomic PostgreSQL queue operations                 |
| `src/inngest/functions/drain-pending-actions.ts`       | Scheduled import, batch publication, and metrics   |
| `src/inngest/functions/process-order-cancellation.ts`  | Cancellation producer                              |
| `src/inngest/functions/process-shopify-fulfillment.ts` | Fulfillment producer                               |
