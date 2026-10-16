BEGIN;

\ir assertions_up/001_schema_and_rls.sql
\ir assertions_up/002_runtime_access.sql
\ir assertions_up/003_refund_operations.sql
\ir assertions_up/004_pending_lifecycle_actions.sql
\ir assertions_up/006_openai_ads_conversions.sql
\ir assertions_up/007_reconciliation_history.sql
\ir assertions_up/008_webhook_inbox_idempotency.sql
\ir assertions_up/009_event_outbox_timeline_capture.sql
\ir assertions_up/010_workflow_timeline_hub_access.sql
\ir assertions_up/005_authenticated_permissions.sql

ROLLBACK;
