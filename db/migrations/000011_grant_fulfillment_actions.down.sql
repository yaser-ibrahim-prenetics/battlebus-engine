DROP POLICY fulfillment_actions_runtime ON public.fulfillment_actions;
REVOKE SELECT, INSERT, UPDATE ON public.fulfillment_actions FROM battle_bus_runtime;
