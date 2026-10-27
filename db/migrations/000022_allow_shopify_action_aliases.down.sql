ALTER TABLE public.fulfillment_action_aliases DROP CONSTRAINT fulfillment_action_aliases_provider_check;
ALTER TABLE public.fulfillment_action_aliases ADD CONSTRAINT fulfillment_action_aliases_provider_check
  CHECK (provider IN ('gps', 'dynamics'));
