BEGIN;

CREATE INDEX idx_event_outbox_due
  ON public.event_outbox (available_at, created_at)
  WHERE state = 'pending';
CREATE INDEX idx_event_outbox_expired_lease
  ON public.event_outbox (lease_expires_at)
  WHERE state = 'processing';
CREATE INDEX idx_event_outbox_inbox
  ON public.event_outbox (inbox_id, state);
CREATE INDEX idx_event_outbox_order
  ON public.event_outbox (shopify_order_id, created_at DESC);
CREATE INDEX idx_event_outbox_dead_letter
  ON public.event_outbox (dead_lettered_at DESC)
  WHERE state = 'dead_letter';

COMMIT;
