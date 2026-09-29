BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'battle-hub-runtime@battle-bus-509406.iam'
  ) THEN
    EXECUTE 'REVOKE battle_hub_runtime FROM "battle-hub-runtime@battle-bus-509406.iam"';
  END IF;
END
$$;

DROP POLICY IF EXISTS pending_lifecycle_actions_battle_hub_read
  ON public.pending_lifecycle_actions;
REVOKE SELECT ON TABLE public.pending_lifecycle_actions FROM battle_hub_runtime;
REVOKE USAGE ON SCHEMA public FROM battle_hub_runtime;
DROP ROLE IF EXISTS battle_hub_runtime;

COMMIT;
