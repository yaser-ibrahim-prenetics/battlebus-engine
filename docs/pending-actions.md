# Durable pending lifecycle actions

Shopify can deliver fulfillment or cancellation events before the corresponding
D365 or GPS record is visible. Battle Bus persists those events in Cloud SQL and
replays them after the downstream order is ready. Refunds use the dedicated
`refund_operations` ledger documented in [Flow 5](./flows/05-refunds.md), which
combines database deduplication with repeated order-availability recovery.

## Ownership and flow

Battle Bus is the only writer and replay owner. Battle Hub receives read-only
access for operator visibility.

```text
Shopify or Battle Hub action
  -> Battle Bus lifecycle function
  -> downstream record missing
  -> INSERT pending_lifecycle_actions (deduplicated)
  -> drain-pending-actions claims a leased batch
  -> Inngest events emitted with stable event IDs
  -> each claimed row marked published or superseded
  -> Battle Hub reads active rows through its server API
```

The queue does not depend on Battle Hub availability. It also does not clear an
entire order-wide JSON array after sending. Each action has its own status and
completion timestamp, so actions that arrive during a drain cannot be erased.

## Database model

Migration `000006_create_durable_pending_lifecycle_actions` creates
`public.pending_lifecycle_actions` with:

- a stable SHA-256 `idempotency_key` for conflict-safe insertion;
- `pending`, `processing`, `published`, and `superseded` states;
- claim tokens and bounded leases for crash recovery;
- attempt counters and timestamps for auditability;
- indexes for ready work, expired leases, order lookup, and Hub reporting.

Lifecycle event payloads are retained only while an action is active. A
database trigger scrubs `event_data` when a row becomes `published` or
`superseded`, while the stable idempotency key and operational timestamps remain
available for audit and deduplication.

Battle Bus inherits write access through `service_role`. Migration
`000007_create_battle_hub_runtime_role` adds Battle Hub's
`battle_hub_runtime` role and a security-barrier view containing only active
operational metadata. Migration
`000008_bind_battle_hub_iam_database_user` binds the Cloud SQL IAM database
user to that role. The Hub role cannot select the private queue table,
`event_data`, or terminal rows. Browser clients and the generic `authenticated`
role have no direct access to the queue.

The legacy `orders.pending_actions` column remains during the expand/deploy
window for rollback compatibility. New Battle Bus revisions do not read or
write it. Removing it requires a later contract migration after all rollback
revisions and external consumers have been verified.

## Replay guarantees

The drain runs every configured interval and uses three durable Inngest steps:

1. Atomically claim ready rows with `FOR UPDATE SKIP LOCKED` and a five-minute
   lease, returning only the claim token and count from the Inngest step.
2. Load payloads transiently inside the emit step, consult durable cancellation
   state, and emit each action with `pending-action-<queue UUID>` as the event
   ID.
3. Mark only the claimed row IDs as published or superseded and scrub their
   payloads before the step completes.

If a worker stops after emission but before completion, the lease eventually
expires. The next replay uses the same event ID, allowing Inngest to deduplicate
the publication. A fulfillment claimed alongside a cancellation for the same
order is marked `superseded`; cancellation has priority.

Fulfillment and cancellation handlers refuse to enqueue again when `fromDrain`
is present. Refund recovery is intentionally separate: the database ledger
returns missing-order refunds to `awaiting_order` with bounded backoff instead
of treating the first replay as terminal. Refund recovery uses single-use
dispatch leases and a 12-attempt budget; exhausted operations become terminal
dead letters and have their retained payloads scrubbed.

## Battle Hub visibility

Battle Hub connects with its Cloud Run service account through the Cloud SQL
Node.js connector and IAM database authentication. Its
`GET /api/orders/pending-actions` route accepts either an authenticated Hub user
or the internal service secret and returns active rows. The order detail dialog
uses the single-order form:

```text
GET /api/orders/pending-actions?shopifyOrderId=<numeric-id>
```

Queue mutation through the Hub API is intentionally rejected. This keeps
durability and replay ownership in Battle Bus.

## Deployment order

1. Run `scripts/bootstrap-hub-database.sh`.
2. Apply migrations `000006` through `000013` through the isolated migration
   job.
3. Deploy Battle Bus so all new actions use Cloud SQL directly.
4. Deploy Battle Hub and verify `/api/health/database` on its no-traffic
   candidate before promotion.

Deploying Battle Bus before the new Hub revision preserves rollback safety: the
old Hub endpoint remains available until no active Battle Bus revision depends
on it.
