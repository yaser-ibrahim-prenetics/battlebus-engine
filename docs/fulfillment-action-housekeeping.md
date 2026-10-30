# Fulfillment-action housekeeping

PR 8 adds bounded retention and unresolved-action alerting for the fulfillment action ledger.
The workflow is disabled by default and must not be enabled until migration `000068` has completed.

## Behavior

- Runs daily at `02:15 UTC` and accepts the internal
  `fulfillment-actions/housekeeping.requested` successor event.
- Uses both Inngest concurrency `1` and a PostgreSQL advisory transaction lock. Cron, retry and
  successor invocations therefore cannot clean or alert concurrently across Cloud Run revisions.
- Retains terminal `succeeded` and `failed` actions for 90 days by default. The approved minimum is
  30 days.
- Never automatically deletes `pending` or `uncertain` actions.
- Deletes at most 100 terminal action rows per transaction, oldest first. Aliases and provider
  evidence are deleted only after no retained action still references them.
- Enqueues one Slack outbox alert per unresolved attempt per UTC day after 24 hours. The payload is
  limited to action ID, operation, provider, order reference, age and safe error category.
- Creates one delayed successor only when eligible work remains. The current workflow sleeps before
  sending it, so a backlog has at most one outstanding successor per active chain.

Terminal provider result bodies and recovery context are physically removed with the ledger row at
the retention boundary. Unresolved rows retain the existing request digest and minimal recovery
context because those fields are necessary for reconciliation; full customer, address and credential
data is not added to the ledger or alert.

## Configuration

| Variable                                                  | Default |  Bounds | Purpose                                  |
| --------------------------------------------------------- | ------: | ------: | ---------------------------------------- |
| `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED`                 | `false` | boolean | Runtime activation gate                  |
| `FULFILLMENT_ACTION_RETENTION_DAYS`                       |      90 | 30–3650 | Terminal action retention                |
| `FULFILLMENT_ACTION_HOUSEKEEPING_BATCH_SIZE`              |     100 |   1–100 | Maximum action deletions per transaction |
| `FULFILLMENT_ACTION_UNRESOLVED_ALERT_HOURS`               |      24 | 24–8760 | Age before the first alert               |
| `FULFILLMENT_ACTION_ALERT_REPEAT_HOURS`                   |      24 | 24–8760 | Minimum repeat-alert interval            |
| `FULFILLMENT_ACTION_ALERT_BATCH_SIZE`                     |     100 |   1–100 | Maximum attempts alerted per transaction |
| `FULFILLMENT_ACTION_HOUSEKEEPING_SUCCESSOR_DELAY_MINUTES` |       1 |    1–60 | Delay before a backlog successor         |

## Rollout

1. Deploy with `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=false`.
2. Apply migration `000068` with the Cloud Run migration job.
3. Confirm the new indexes, trigger and `delete_retained_fulfillment_actions(integer, integer)`
   function exist; the application role must have only function execution, not table deletion.
4. Query terminal counts at 90 days and unresolved counts at 24 hours. Review a sample for expected
   retention and safe alert fields.
5. Set the GitHub repository variable `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=true` and deploy.
6. Verify one Inngest run, bounded deletion counts, Slack outbox publication and no unresolved-row
   deletion.

## Rollback

Set `FULFILLMENT_ACTION_HOUSEKEEPING_ENABLED=false` and deploy. This stops new cleanup and alerts
without reversing migration `000068`; production schema rollback remains a separate operator action.
