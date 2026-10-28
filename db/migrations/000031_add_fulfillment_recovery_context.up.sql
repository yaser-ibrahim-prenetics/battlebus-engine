ALTER TABLE public.fulfillment_actions ADD COLUMN recovery_context jsonb;
ALTER TABLE public.fulfillment_actions ADD CONSTRAINT fulfillment_recovery_context_object
  CHECK (recovery_context IS NULL OR jsonb_typeof(recovery_context) = 'object');
