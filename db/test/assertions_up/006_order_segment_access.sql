DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['order_segment_plans', 'order_segment_fulfillments'] LOOP
    IF NOT has_table_privilege('battle_bus_runtime', 'public.' || table_name, 'SELECT,INSERT') OR
       has_table_privilege('battle_bus_runtime', 'public.' || table_name, 'DELETE,TRUNCATE') OR
       has_table_privilege('authenticated', 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE') OR
       has_table_privilege('anon', 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE') OR
       NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass) THEN
      RAISE EXCEPTION 'Order segment privilege contract failed for %', table_name;
    END IF;
  END LOOP;
  IF has_column_privilege('battle_bus_runtime', 'public.order_segment_plans', 'plan', 'UPDATE') OR
     NOT has_column_privilege('battle_bus_runtime', 'public.order_segment_plans', 'progress', 'UPDATE') THEN
    RAISE EXCEPTION 'Runtime must update progress without rewriting immutable plans';
  END IF;
END $$;
