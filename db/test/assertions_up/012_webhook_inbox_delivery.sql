DO $$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY ARRAY[
    'next_attempt_at', 'lease_token', 'lease_expires_at',
    'dead_lettered_at', 'replay_count', 'last_replay_request_id', 'updated_at'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'webhook_inbox'
        AND information_schema.columns.column_name = column_name
    ) THEN
      RAISE EXCEPTION 'webhook_inbox.% is missing', column_name;
    END IF;
  END LOOP;

  IF to_regclass('public.idx_webhook_inbox_ready') IS NULL
    OR to_regclass('public.idx_webhook_inbox_expired_lease') IS NULL
    OR to_regclass('public.idx_webhook_inbox_dead_letter') IS NULL
    OR to_regclass('public.idx_webhook_inbox_retention') IS NULL
  THEN
    RAISE EXCEPTION 'Webhook inbox delivery indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.webhook_inbox'::regclass
      AND tgname = 'battle_platform_webhook_inbox_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Webhook inbox updated-at trigger is missing';
  END IF;

  IF has_table_privilege('authenticated', 'public.webhook_inbox', 'SELECT')
    OR has_table_privilege('anon', 'public.webhook_inbox', 'SELECT')
  THEN
    RAISE EXCEPTION 'Webhook inbox is exposed to client database roles';
  END IF;
END
$$;
