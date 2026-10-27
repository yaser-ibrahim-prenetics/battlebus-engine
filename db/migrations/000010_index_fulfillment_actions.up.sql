CREATE INDEX fulfillment_actions_source ON public.fulfillment_actions (provider, scope, source_order_id, source_line_id);
CREATE INDEX fulfillment_actions_unresolved ON public.fulfillment_actions (updated_at) WHERE status IN ('pending', 'uncertain');
