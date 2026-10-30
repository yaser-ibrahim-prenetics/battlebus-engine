DROP INDEX IF EXISTS public.fulfillment_actions_terminal_retention;
DROP INDEX IF EXISTS public.fulfillment_actions_unresolved_age;

DROP FUNCTION IF EXISTS public.delete_retained_fulfillment_actions(integer, integer);

ALTER TABLE public.fulfillment_actions
  DROP CONSTRAINT IF EXISTS fulfillment_actions_unresolved_age;

DROP TRIGGER IF EXISTS fulfillment_actions_track_unresolved_age
  ON public.fulfillment_actions;
DROP FUNCTION IF EXISTS public.battle_platform_track_fulfillment_unresolved_age();

ALTER TABLE public.fulfillment_actions
  DROP COLUMN IF EXISTS last_unresolved_alert_at,
  DROP COLUMN IF EXISTS unresolved_since;
