ALTER TABLE public.fulfillment_actions DROP CONSTRAINT fulfillment_actions_provider_check;
ALTER TABLE public.fulfillment_actions ADD CONSTRAINT fulfillment_actions_provider_check
  CHECK (provider IN ('gps', 'dynamics', 'shopify'));
