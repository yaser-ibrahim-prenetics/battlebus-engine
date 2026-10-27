DO $$
BEGIN
  IF to_regclass('public.order_segment_plans') IS NULL OR
     to_regclass('public.order_segment_fulfillments') IS NULL THEN
    RAISE EXCEPTION 'Order segment storage is missing';
  END IF;
END $$;
