CREATE INDEX pending_lifecycle_actions_ready_idx
  ON public.pending_lifecycle_actions (priority, available_at, created_at, action_id)
  WHERE status = 'queued';

CREATE INDEX pending_lifecycle_actions_expired_lease_idx
  ON public.pending_lifecycle_actions (lease_expires_at, priority, created_at, action_id)
  WHERE status = 'publishing';

CREATE INDEX pending_lifecycle_actions_order_status_idx
  ON public.pending_lifecycle_actions (order_id, status, action_type);
