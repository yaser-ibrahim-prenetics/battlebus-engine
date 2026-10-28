DO $$
BEGIN
  IF NOT has_table_privilege('battle_bus_runtime','public.order_segment_refunds','SELECT,INSERT,UPDATE') OR
     has_table_privilege('authenticated','public.order_segment_refunds','SELECT') OR
     has_table_privilege('anon','public.order_segment_refunds','INSERT') THEN
    RAISE EXCEPTION 'Segment refund privilege contract failed';
  END IF;
END $$;
