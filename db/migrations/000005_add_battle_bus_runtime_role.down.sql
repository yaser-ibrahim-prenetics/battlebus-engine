DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle-bus-runtime@battle-bus-509406.iam'
  ) THEN
    EXECUTE 'REVOKE battle_bus_runtime FROM "battle-bus-runtime@battle-bus-509406.iam"';
  END IF;
END
$$;

REVOKE service_role FROM battle_bus_runtime;
DROP ROLE IF EXISTS battle_bus_runtime;
