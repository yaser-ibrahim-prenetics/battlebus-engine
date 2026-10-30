INSERT INTO public.fulfillment_actions (
  action_key,
  provider,
  scope,
  source_order_id,
  source_line_id,
  action_name,
  request_hash,
  attempt_id,
  status,
  result,
  created_at,
  updated_at
) VALUES (
  'housekeeping-rollback-fixture',
  'gps',
  'rollback-fixture',
  'ORDER-ROLLBACK',
  'LINE-ROLLBACK',
  'create_outbound_order',
  repeat('c', 64),
  '00000000-0000-4000-8000-000000000068'::uuid,
  'succeeded',
  '{"orderNo":"GPS-ROLLBACK","logisticsChannel":"standard"}'::jsonb,
  now() - interval '91 days',
  now() - interval '91 days'
);

SELECT * FROM public.delete_retained_fulfillment_actions(90, 1);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_actions
    WHERE action_key = 'housekeeping-rollback-fixture'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.fulfillment_action_tombstones
    WHERE action_key = 'housekeeping-rollback-fixture'
  ) THEN
    RAISE EXCEPTION 'Could not prepare the fulfillment housekeeping rollback fixture';
  END IF;
END
$$;
