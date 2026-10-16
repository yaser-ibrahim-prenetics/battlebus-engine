BEGIN;

DROP INDEX IF EXISTS public.idx_webhook_inbox_schema_version;
DROP INDEX IF EXISTS public.idx_webhook_inbox_source_idempotency;

COMMIT;
