DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'battle_bus_runtime') THEN
    CREATE ROLE battle_bus_runtime NOLOGIN;
  END IF;
END
$$;

GRANT service_role TO battle_bus_runtime;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle-bus-runtime@battle-bus-509406.iam'
  ) THEN
    EXECUTE 'GRANT battle_bus_runtime TO "battle-bus-runtime@battle-bus-509406.iam"';
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
    RAISE EXCEPTION
      'Cloud SQL IAM database user battle-bus-runtime@battle-bus-509406.iam is missing. Run scripts/bootstrap-runtime-database.sh before migrations.';
  END IF;
END
$$;

COMMENT ON ROLE battle_bus_runtime IS
  'NOLOGIN group role inherited by the Battle Bus Cloud Run IAM database user.';
