export const enqueuePendingActionSQL = `
INSERT INTO public.pending_lifecycle_actions (
  order_id,
  action_type,
  source_event_id,
  event_name,
  event_data
) VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT (order_id, action_type, source_event_id)
DO UPDATE SET source_event_id = EXCLUDED.source_event_id
RETURNING action_id`;
