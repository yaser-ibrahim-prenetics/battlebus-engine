DO $$
BEGIN
  IF NOT has_table_privilege('battle_bus_runtime', 'public.refund_hold_decisions', 'SELECT') OR
     NOT has_table_privilege('battle_bus_runtime', 'public.refund_hold_decisions', 'INSERT') OR
     has_table_privilege('battle_bus_runtime', 'public.refund_hold_decisions', 'UPDATE,DELETE,TRUNCATE') OR
     has_table_privilege('authenticated', 'public.refund_hold_decisions', 'SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('anon', 'public.refund_hold_decisions', 'SELECT,INSERT,UPDATE,DELETE') OR
     NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.refund_hold_decisions'::regclass) THEN
    RAISE EXCEPTION 'Refund hold privilege contract failed';
  END IF;
END $$;
