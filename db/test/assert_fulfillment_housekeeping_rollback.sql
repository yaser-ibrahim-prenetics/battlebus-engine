DO $$
BEGIN
  IF to_regclass('public.fulfillment_action_tombstones') IS NOT NULL THEN
    RAISE EXCEPTION 'Fulfillment housekeeping rollback left tombstones behind';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.fulfillment_actions
    WHERE action_key = 'housekeeping-rollback-fixture'
      AND provider = 'gps'
      AND scope = 'rollback-fixture'
      AND source_order_id = 'ORDER-ROLLBACK'
      AND source_line_id = 'LINE-ROLLBACK'
      AND action_name = 'create_outbound_order'
      AND request_hash = repeat('c', 64)
      AND attempt_id = '00000000-0000-4000-8000-000000000068'::uuid
      AND status = 'succeeded'
      AND result = '{"orderNo":"GPS-ROLLBACK","logisticsChannel":"standard"}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Fulfillment housekeeping rollback did not rehydrate replay identity exactly';
  END IF;
END
$$;
