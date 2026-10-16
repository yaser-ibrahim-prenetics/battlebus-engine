BEGIN;

ALTER TABLE public.webhook_inbox
  ADD COLUMN idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN schema_version text NOT NULL DEFAULT '1.0',
  ADD COLUMN payload_hash text NOT NULL DEFAULT '',
  ADD COLUMN duplicate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.webhook_inbox
SET idempotency_key = id::text,
    payload_hash = encode(digest(payload::text, 'sha256'), 'hex'),
    updated_at = COALESCE(published_at, received_at);

ALTER TABLE public.webhook_inbox
  ADD CONSTRAINT webhook_inbox_duplicate_count_nonnegative
    CHECK (duplicate_count >= 0),
  ADD CONSTRAINT webhook_inbox_schema_version_nonempty
    CHECK (length(btrim(schema_version)) > 0),
  ADD CONSTRAINT webhook_inbox_idempotency_key_nonempty
    CHECK (length(btrim(idempotency_key)) > 0);

COMMENT ON COLUMN public.webhook_inbox.idempotency_key IS
  'Stable producer key used to collapse duplicate webhook deliveries end to end.';
COMMENT ON COLUMN public.webhook_inbox.schema_version IS
  'Version of the source-specific webhook schema used to validate and replay this receipt.';

COMMIT;
