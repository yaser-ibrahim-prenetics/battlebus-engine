BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle-hub-runtime@battle-bus-509406.iam'
  ) AND EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle_hub_runtime'
  ) THEN
    EXECUTE 'REVOKE battle_hub_runtime FROM "battle-hub-runtime@battle-bus-509406.iam"';
  END IF;
END
$$;

COMMIT;
