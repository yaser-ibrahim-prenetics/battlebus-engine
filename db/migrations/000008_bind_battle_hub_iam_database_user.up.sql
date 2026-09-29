BEGIN;

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

COMMIT;
