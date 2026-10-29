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

Scheduled drain (after explicit activation)
  -> copy valid, not-yet-normalized legacy JSON actions under row locks
  -> supersede fulfillment when cancellation is pending
  -> claim a bounded batch with FOR UPDATE SKIP LOCKED
  -> assign a time-limited lease
  -> batch-publish events using pending-action-<action_id>
  -> acknowledge each exact action_id + lease_token
```

If publication is uncertain, the claimed rows return to the queue with exponential backoff. If acknowledgement fails after publication, the lease expires and another worker republishes the same stable event ID. That provides at-least-once delivery without creating a new downstream identity.

## Cancellation priority

A queued or expired fulfillment is marked `superseded` when the same order has an active, published, or unresolved dead-letter cancellation. Claim selection also excludes conflicting fulfillment rows, so a backlog larger than one sweep cannot bypass the rule.

An already active, unexpired fulfillment lease is not stolen. This keeps lease ownership correct; downstream handlers must remain idempotent for the narrow cancellation-versus-publication race.

## Legacy rollout bridge

`orders.pending_actions` remains populated during the expand and rollback phases so older Battle Bus revisions can safely resume. Before activation, producers write only this legacy projection. After activation, producers atomically write the normalized row and retain a deduplicated legacy projection. Before each claim, the drain:

1. locks a bounded set of order rows with non-empty, fully valid JSON action arrays;
2. inserts actions that are not already represented in the normalized queue with a deterministic source ID; and
3. leaves the legacy arrays intact for rollback-capable revisions.

A concurrent legacy append waits for the row lock and is copied on a later sweep. Malformed arrays are excluded without blocking normalized claims. Remove legacy projections only after all writers and rollback-capable revisions use the normalized table and the contract evidence window is complete.

## Activation sequence

1. Apply migrations `000040` through `000044` while `PENDING_ACTIONS_DURABLE_QUEUE_ENABLED=false`.
2. Run `scripts/bootstrap-hub-database.sh` before migration `000044` in Cloud SQL, then verify Battle Hub can read the safe active-action view.
3. Deploy Battle Bus with the durable queue disabled and legacy projection enabled; confirm no old drain revision receives traffic.
4. Set the repository variable `PENDING_ACTIONS_DURABLE_QUEUE_ENABLED=true` and deploy again.
5. Keep `PENDING_ACTIONS_LEGACY_PROJECTION_ENABLED=true` throughout the rollback window.
6. Disable the legacy projection and remove legacy data only in a later reviewed contract release.

## Configuration

| Variable                                    | Default | Range  | Purpose                              |
| ------------------------------------------- | ------: | ------ | ------------------------------------ |
| `PENDING_ACTIONS_DURABLE_QUEUE_ENABLED`     | `false` | bool   | Activate normalized writes and drain |
| `PENDING_ACTIONS_LEGACY_PROJECTION_ENABLED` |  `true` | bool   | Retain rollback-readable writes      |
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
- Compare retained legacy arrays with normalized rows during the rollback window; an action missing from the normalized queue indicates malformed input or import lag.
- Battle Hub reads only `battle_hub_pending_lifecycle_actions`; payloads and terminal rows are never exposed through that view.

## Files

| File                                                   | Responsibility                                      |
| ------------------------------------------------------ | --------------------------------------------------- |
| `db/migrations/000040_*` through `000044_*`            | Queue schema, indexes, runtime access, and rollback |
| `src/lib/services/pending-actions.ts`                  | Validation, enqueue, claim, acknowledgement, retry  |
| `src/lib/sql/pending-actions/`                         | Atomic PostgreSQL queue operations                  |
| `src/inngest/functions/drain-pending-actions.ts`       | Scheduled import, batch publication, and metrics    |
| `src/inngest/functions/process-order-cancellation.ts`  | Cancellation producer                               |
| `src/inngest/functions/process-shopify-fulfillment.ts` | Fulfillment producer                                |
