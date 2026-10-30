# Fulfillment-action housekeeping

PR 8 adds bounded retention and unresolved-action alerting for the fulfillment action ledger.
The workflow is disabled by default and must not be enabled until migration `000068` has completed.

## Behavior

- Runs daily at `02:15 UTC` and accepts the internal
  `fulfillment-actions/housekeeping.requested` successor event.
- Uses both Inngest concurrency `1` and a PostgreSQL advisory transaction lock. Cron, retry and
  successor invocations therefore cannot clean or alert concurrently across Cloud Run revisions.
- Retains terminal `succeeded` and `failed` actions for at least 90 days.
- Never automatically deletes `pending` or `uncertain` actions.
- Deletes at most 100 terminal action rows per transaction, oldest first. Successful actions move
  first to immutable minimal replay tombstones; aliases and provider evidence remain as compact
  idempotency and audit relationships.
- Enqueues one Slack outbox alert per unresolved attempt per UTC day after 24 hours. The payload is
  limited to action ID, operation, provider, order reference, age and safe error category.
- Creates one delayed successor only when eligible work remains. A singleton PostgreSQL claim is
  committed with each batch, idempotently authorized immediately before publication, and consumed
  by the successor. Bounded 90-day batch receipts return the already-committed successor after an
  ambiguous Inngest checkpoint. Separate cron/retry roots therefore cannot create parallel successor
  chains; an expired unpublished claim can be recovered by a later root.
- Quarantines a terminal success when its legacy result does not match a supported replay codec,
  retains the active row, emits one safe operator alert, and continues later retention/alert work.
  Operators must add or correct the codec, verify the provider result, then remove the quarantine row
  through a reviewed database change so housekeeping can archive it on a later run.

Terminal recovery context is removed with the active ledger row at the retention boundary. A
successful tombstone retains only action identity, request hash and a validated per-operation replay
result capped at 2 KiB. Unsupported result shapes fail closed instead of being archived. Unresolved
rows retain the request digest and minimal recovery context
because those fields are necessary for reconciliation; full customer, address and credential data is
not added to the ledger or alert.

## Configuration

| Variable                                                  | Default |  Bounds | Purpose                                  |
| --------------------------------------------------------- | ------: | ------: | ---------------------------------------- |
| `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED`                 | `false` | boolean | Runtime activation gate                  |
| `FULFILLMENT_ACTION_RETENTION_DAYS`                       |      90 | 90–3650 | Terminal action retention                |
| `FULFILLMENT_ACTION_HOUSEKEEPING_BATCH_SIZE`              |     100 |   1–100 | Maximum action deletions per transaction |
| `FULFILLMENT_ACTION_ALERT_REPEAT_HOURS`                   |      24 | 24–8760 | Minimum repeat-alert interval            |
| `FULFILLMENT_ACTION_ALERT_BATCH_SIZE`                     |     100 |   1–100 | Maximum attempts alerted per transaction |
| `FULFILLMENT_ACTION_HOUSEKEEPING_SUCCESSOR_DELAY_MINUTES` |       1 |    1–60 | Delay before a backlog successor         |

## Rollout

1. Keep `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=false`.
2. Apply migration `000068` with the Cloud Run migration job before routing traffic to this binary.
   The tombstone reader is part of the core fulfillment idempotency path even while cleanup is off,
   so readiness intentionally fails until the migration and runtime privileges are present.
3. Confirm the new indexes, trigger and `delete_retained_fulfillment_actions(integer, integer)`
   function exist; confirm the actual Cloud Run database principal inherits `battle_bus_runtime`, can
   read tombstones and execute the bounded functions, and has no direct delete/table-write grants.
4. Query terminal counts at 90 days and unresolved counts at 24 hours. Review a sample for expected
   retention and safe alert fields.
5. Set the GitHub repository variable `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=true` and deploy.
6. Verify one Inngest run, bounded deletion counts, Slack outbox publication and no unresolved-row
   deletion.

## Rollback

Set `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=false` to stop new cleanup and alerts without reversing
migration `000068`. A rollback to a pre-tombstone-aware application requires a traffic-drained
maintenance window: stop routing requests to all Battle Bus revisions, verify no fulfillment writes
or Inngest runs remain active, and only then run the down migration. It transactionally rehydrates
archived successes into the compatible active ledger before dropping tombstones and fails closed on
any identity/result mismatch. Deploy the older revision and restore traffic only after the migration
succeeds. Never run this schema contraction while the current revision can serve requests.
