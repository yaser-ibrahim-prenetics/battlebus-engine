-- Metadata-only inventory; run on an approved read-only connection, preferably the replica.
-- psql "$APPROVED_READONLY_URL" -v date_from='2026-10-01' -v date_to='2026-10-02' -f scripts/cutover/spock-inventory.sql
-- Confirm deployed schema mapping first. "store" comes from Spock's checked-in config.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT type, COALESCE(detail->>'topic', '(no topic)') AS topic, status,
  count(*) AS samples, min(datetime) AS first_seen, max(datetime) AS last_seen
FROM store.task
WHERE datetime >= :'date_from'::timestamp AND datetime < :'date_to'::timestamp
GROUP BY type, detail->>'topic', status
ORDER BY type, topic, status;
ROLLBACK;
