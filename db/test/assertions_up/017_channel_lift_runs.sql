DO $$
DECLARE
  rls_enabled boolean;
  attempts_rls_enabled boolean;
  identities_rls_enabled boolean;
BEGIN
  IF to_regclass('public.channel_lift_runs') IS NULL
    OR to_regclass('public.channel_lift_run_attempts') IS NULL
    OR to_regclass('public.channel_lift_request_identities') IS NULL
    OR to_regclass('public.idx_channel_lift_one_active_date') IS NULL
    OR to_regclass('public.idx_channel_lift_runs_recent') IS NULL
    OR to_regclass('public.battle_hub_channel_lift_runs') IS NULL
    OR to_regclass('public.battle_hub_channel_lift_run_attempts') IS NULL
    OR to_regclass('public.battle_hub_channel_lift_request_identities') IS NULL
  THEN
    RAISE EXCEPTION 'Channel-lift evidence schema is incomplete';
  END IF;

  SELECT relrowsecurity INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.channel_lift_runs'::regclass;

  SELECT relrowsecurity INTO attempts_rls_enabled
  FROM pg_class
  WHERE oid = 'public.channel_lift_run_attempts'::regclass;

  SELECT relrowsecurity INTO identities_rls_enabled
  FROM pg_class
  WHERE oid = 'public.channel_lift_request_identities'::regclass;

  IF rls_enabled IS DISTINCT FROM true
    OR attempts_rls_enabled IS DISTINCT FROM true
    OR identities_rls_enabled IS DISTINCT FROM true
    OR NOT has_table_privilege('battle_bus_runtime', 'public.channel_lift_runs', 'SELECT')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.channel_lift_runs', 'INSERT')
    OR NOT has_column_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'status', 'UPDATE'
    )
    OR EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'run_id', 'reporting_date', 'mode', 'source', 'request_id',
        'requested_by', 'reason_code', 'reference_id',
        'eligibility_cutoff_seconds', 'created_at', 'updated_at'
      ]) AS immutable(column_name)
      WHERE has_column_privilege(
        'battle_bus_runtime', 'public.channel_lift_runs', immutable.column_name, 'UPDATE'
      )
    )
    OR has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_runs', 'DELETE,TRUNCATE'
    )
    OR has_table_privilege('anon', 'public.channel_lift_runs', 'SELECT')
    OR has_table_privilege('authenticated', 'public.channel_lift_runs', 'SELECT')
    OR NOT has_table_privilege(
      'battle_hub_runtime', 'public.battle_hub_channel_lift_runs', 'SELECT'
    )
    OR has_table_privilege('battle_hub_runtime', 'public.channel_lift_runs', 'SELECT')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.channel_lift_run_attempts', 'SELECT')
    OR NOT has_table_privilege('battle_bus_runtime', 'public.channel_lift_run_attempts', 'INSERT')
    OR has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_run_attempts', 'UPDATE,DELETE,TRUNCATE'
    )
    OR has_any_column_privilege(
      'battle_bus_runtime', 'public.channel_lift_run_attempts', 'UPDATE'
    )
    OR NOT has_table_privilege(
      'battle_hub_runtime', 'public.battle_hub_channel_lift_run_attempts', 'SELECT'
    )
    OR NOT has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_request_identities', 'SELECT'
    )
    OR NOT has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_request_identities', 'INSERT'
    )
    OR has_any_column_privilege(
      'battle_bus_runtime', 'public.channel_lift_request_identities', 'UPDATE'
    )
    OR has_table_privilege(
      'battle_bus_runtime', 'public.channel_lift_request_identities', 'DELETE,TRUNCATE'
    )
    OR NOT has_table_privilege(
      'battle_hub_runtime', 'public.battle_hub_channel_lift_request_identities', 'SELECT'
    )
  THEN
    RAISE EXCEPTION 'Channel-lift evidence privilege contract failed';
  END IF;

  IF to_regprocedure('public.battle_platform_enforce_channel_lift_transition()') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'public.channel_lift_runs'::regclass
        AND tgname = 'battle_platform_enforce_channel_lift_transition'
        AND tgfoid = 'public.battle_platform_enforce_channel_lift_transition()'::regprocedure
        AND tgenabled IN ('O', 'A')
        AND NOT tgisinternal
    )
  THEN
    RAISE EXCEPTION 'Channel-lift transition guard is missing';
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'channel_lift_runs'
        AND policyname = 'channel_lift_runtime' AND cmd = 'ALL'
        AND qual = 'true' AND with_check = 'true'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'channel_lift_run_attempts'
        AND policyname = 'channel_lift_attempt_runtime' AND cmd = 'ALL'
        AND qual = 'true' AND with_check = 'true'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'channel_lift_request_identities'
        AND policyname = 'channel_lift_request_identity_runtime' AND cmd = 'ALL'
        AND qual = 'true' AND with_check = 'true'
    )
  THEN
    RAISE EXCEPTION 'Channel-lift RLS policy contract failed';
  END IF;

  IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.channel_lift_runs'::regclass
        AND conname = 'channel_lift_runs_request_identity_fkey'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE
          'FOREIGN KEY (request_id, mode, source) REFERENCES channel_lift_request_identities(request_id, mode, source)%'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.channel_lift_run_attempts'::regclass
        AND conname = 'channel_lift_attempt_request_identity_fkey'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE
          'FOREIGN KEY (request_id, mode, source) REFERENCES channel_lift_request_identities(request_id, mode, source)%'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.channel_lift_run_attempts'::regclass
        AND conname = 'channel_lift_attempt_run_identity_fkey'
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE
          'FOREIGN KEY (run_id, request_id, mode, source) REFERENCES channel_lift_runs(run_id, request_id, mode, source)%'
    )
  THEN
    RAISE EXCEPTION 'Channel-lift request identity foreign-key contract failed';
  END IF;
END
$$;

DO $$
BEGIN
  INSERT INTO public.channel_lift_request_identities (request_id, mode, source)
  VALUES
    ('migration:channel-lift-dry', 'dry_run', 'manual'),
    ('migration:channel-lift-live', 'live', 'manual');

  INSERT INTO public.channel_lift_runs (
    run_id, reporting_date, mode, source, request_id, requested_by, reason_code
  ) VALUES (
    'channel_lift_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DATE '2077-01-01',
    'dry_run',
    'manual',
    'migration:channel-lift-dry',
    'migration-test@example.com',
    'parity_validation'
  );

  BEGIN
    INSERT INTO public.channel_lift_run_attempts (
      request_id, run_id, mode, source, requested_by, reason_code
    ) VALUES (
      'migration:channel-lift-live',
      'channel_lift_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'live',
      'manual',
      'migration-test@example.com',
      'parity_validation'
    );
    RAISE EXCEPTION 'Cross-run channel-lift attempt identity unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  DELETE FROM public.channel_lift_runs
  WHERE run_id = 'channel_lift_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  DELETE FROM public.channel_lift_request_identities
  WHERE request_id IN ('migration:channel-lift-dry', 'migration:channel-lift-live');
END
$$;
