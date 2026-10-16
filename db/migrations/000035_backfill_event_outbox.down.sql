BEGIN;

-- Backfilled delivery work is intentionally retained on rollback so that
-- retryable webhook events cannot be lost. Migration 000027 removes the
-- entire outbox if the schema is rolled back past its introduction.

COMMIT;
