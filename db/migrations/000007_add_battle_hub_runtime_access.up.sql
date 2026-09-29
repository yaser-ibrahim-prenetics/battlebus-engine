BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'battle_hub_runtime') THEN
    CREATE ROLE battle_hub_runtime NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO battle_hub_runtime;
GRANT SELECT ON TABLE public.pending_lifecycle_actions TO battle_hub_runtime;

CREATE POLICY pending_lifecycle_actions_battle_hub_read
  ON public.pending_lifecycle_actions
  FOR SELECT TO battle_hub_runtime
  USING (true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle-hub-runtime@battle-bus-509406.iam'
  ) THEN
    EXECUTE 'GRANT battle_hub_runtime TO "battle-hub-runtime@battle-bus-509406.iam"';
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
    RAISE EXCEPTION
      'Cloud SQL IAM database user battle-hub-runtime@battle-bus-509406.iam is missing. Run scripts/bootstrap-hub-database.sh before migrations.';
  END IF;
END
$$;

COMMENT ON ROLE battle_hub_runtime IS
  'NOLOGIN group role inherited by the Battle Hub Cloud Run IAM database user.';

COMMIT;
