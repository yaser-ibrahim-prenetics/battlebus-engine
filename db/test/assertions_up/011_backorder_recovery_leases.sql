BEGIN;

DO $$
BEGIN
  IF NOT has_table_privilege(
    'battle_bus_runtime',
    'public.backorder_recovery_leases',
    'SELECT,INSERT,UPDATE'
  ) THEN
    RAISE EXCEPTION 'battle_bus_runtime cannot manage backorder recovery leases';
  END IF;

  IF has_table_privilege(
    'battle_bus_runtime',
    'public.backorder_recovery_leases',
    'DELETE,TRUNCATE'
  ) THEN
    RAISE EXCEPTION 'battle_bus_runtime has destructive backorder lease privileges';
  END IF;

  IF has_table_privilege('anon', 'public.backorder_recovery_leases', 'SELECT')
    OR has_table_privilege('authenticated', 'public.backorder_recovery_leases', 'SELECT')
  THEN
    RAISE EXCEPTION 'Backorder recovery leases are exposed to client roles';
  END IF;
END
$$;

SET LOCAL ROLE battle_bus_runtime;

INSERT INTO public.backorder_recovery_leases (
  shopify_store,
  order_id,
  lease_token,
  lease_expires_at,
  last_operation_key,
  last_lease_owner
) VALUES (
  'migration-test.myshopify.com',
  'backorder-lease-test',
  gen_random_uuid(),
  now() + interval '10 minutes',
  'migration-test-operation',
  'migration-test-owner'
);

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.backorder_recovery_leases
    WHERE shopify_store = 'migration-test.myshopify.com'
      AND order_id = 'backorder-lease-test'
  ) <> 1 THEN
    RAISE EXCEPTION 'Runtime role could not create a backorder recovery lease';
  END IF;
END
$$;

ROLLBACK;
