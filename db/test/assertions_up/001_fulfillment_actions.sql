DO $$
BEGIN
  IF to_regclass('public.fulfillment_actions') IS NULL OR
     NOT has_table_privilege('battle_bus_runtime', 'public.fulfillment_actions', 'INSERT,UPDATE,SELECT') OR
     has_table_privilege('authenticated', 'public.fulfillment_actions', 'SELECT') OR
     has_table_privilege('anon', 'public.fulfillment_actions', 'INSERT') THEN
    RAISE EXCEPTION 'Fulfillment ledger storage or privilege contract failed';
  END IF;
END $$;
