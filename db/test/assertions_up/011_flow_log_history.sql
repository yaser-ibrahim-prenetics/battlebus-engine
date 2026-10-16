INSERT INTO public.flow_logs (
  id,
  flow,
  step,
  shopify_order_id,
  shopify_order_name,
  status
)
VALUES (
  '00000000-0000-0000-0000-000000000804',
  'order_processing',
  'complete',
  '801',
  '#IM8-801',
  'completed'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.flow_logs
    WHERE id = '00000000-0000-0000-0000-000000000804'
      AND shopify_order_id = '801'
  ) THEN
    RAISE EXCEPTION 'Flow-log history did not preserve the order reference';
  END IF;
END
$$;
