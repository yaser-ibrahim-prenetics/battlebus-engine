BEGIN;

DROP INDEX IF EXISTS public.idx_event_outbox_dead_letter;
DROP INDEX IF EXISTS public.idx_event_outbox_order;
DROP INDEX IF EXISTS public.idx_event_outbox_inbox;
DROP INDEX IF EXISTS public.idx_event_outbox_expired_lease;
DROP INDEX IF EXISTS public.idx_event_outbox_due;

COMMIT;
