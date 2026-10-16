BEGIN;

CREATE UNIQUE INDEX idx_webhook_inbox_source_idempotency
  ON public.webhook_inbox (source, idempotency_key);

CREATE INDEX idx_webhook_inbox_schema_version
  ON public.webhook_inbox (source, schema_version);

COMMIT;
