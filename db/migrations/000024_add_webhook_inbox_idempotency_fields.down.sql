BEGIN;

ALTER TABLE public.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_idempotency_key_nonempty,
  DROP CONSTRAINT IF EXISTS webhook_inbox_schema_version_nonempty,
  DROP CONSTRAINT IF EXISTS webhook_inbox_duplicate_count_nonnegative,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS duplicate_count,
  DROP COLUMN IF EXISTS payload_hash,
  DROP COLUMN IF EXISTS schema_version,
  DROP COLUMN IF EXISTS idempotency_key;

COMMIT;
