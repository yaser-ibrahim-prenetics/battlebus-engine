BEGIN;

\ir assertions_up/001_schema_and_rls.sql
\ir assertions_up/002_runtime_access.sql
\ir assertions_up/003_refund_operations.sql
\ir assertions_up/004_pending_lifecycle_actions.sql
\ir assertions_up/006_openai_ads_conversions.sql
\ir assertions_up/007_reconciliation_history.sql
\ir assertions_up/008_webhook_inbox_receipt.sql
\ir assertions_up/009_webhook_inbox_deduplication.sql
\ir assertions_up/010_event_outbox_lifecycle.sql
\ir assertions_up/011_flow_log_history.sql
\ir assertions_up/012_workflow_timeline_storage.sql
\ir assertions_up/013_workflow_timeline_hub_access.sql
\ir assertions_up/014_event_outbox_backfill.sql
\ir assertions_up/015_cutover_evidence.sql
\ir assertions_up/016_workflow_run_health.sql
\ir assertions_up/017_replay_writer_isolation.sql
\ir assertions_up/018_workflow_sample_exclusion.sql
\ir assertions_up/005_authenticated_permissions.sql

ROLLBACK;
