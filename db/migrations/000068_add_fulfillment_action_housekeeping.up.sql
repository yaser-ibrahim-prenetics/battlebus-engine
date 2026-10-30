ALTER TABLE public.fulfillment_actions
  ADD COLUMN unresolved_since timestamptz,
  ADD COLUMN last_unresolved_alert_at timestamptz;

UPDATE public.fulfillment_actions
SET unresolved_since = LEAST(created_at, updated_at)
WHERE status IN ('pending', 'uncertain');

CREATE FUNCTION public.battle_platform_track_fulfillment_unresolved_age()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('pending', 'uncertain') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.unresolved_since := COALESCE(NEW.unresolved_since, clock_timestamp());
      NEW.last_unresolved_alert_at := NULL;
    ELSIF OLD.status NOT IN ('pending', 'uncertain') THEN
      NEW.unresolved_since := clock_timestamp();
      NEW.last_unresolved_alert_at := NULL;
    ELSE
      NEW.unresolved_since := OLD.unresolved_since;
    END IF;
  ELSE
    NEW.unresolved_since := NULL;
    NEW.last_unresolved_alert_at := NULL;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER fulfillment_actions_track_unresolved_age
BEFORE INSERT OR UPDATE OF status, unresolved_since ON public.fulfillment_actions
FOR EACH ROW
EXECUTE FUNCTION public.battle_platform_track_fulfillment_unresolved_age();

ALTER TABLE public.fulfillment_actions
  ADD CONSTRAINT fulfillment_actions_unresolved_age
  CHECK (
    (status IN ('pending', 'uncertain') AND unresolved_since IS NOT NULL)
    OR (status IN ('succeeded', 'failed') AND unresolved_since IS NULL)
  );

CREATE INDEX fulfillment_actions_terminal_retention
  ON public.fulfillment_actions (updated_at, action_key)
  WHERE status IN ('succeeded', 'failed');

CREATE INDEX fulfillment_actions_unresolved_age
  ON public.fulfillment_actions (unresolved_since, action_key)
  WHERE status IN ('pending', 'uncertain');

CREATE FUNCTION public.delete_retained_fulfillment_actions(
  retention_days integer,
  batch_size integer
)
RETURNS TABLE (
  deleted integer,
  aliases_deleted integer,
  evidence_deleted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_keys text[];
BEGIN
  IF retention_days < 30 OR retention_days > 3650 THEN
    RAISE EXCEPTION 'retention_days must be between 30 and 3650';
  END IF;
  IF batch_size < 1 OR batch_size > 100 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 100';
  END IF;

  SELECT array_agg(candidate.action_key ORDER BY candidate.updated_at, candidate.action_key)
  INTO candidate_keys
  FROM (
    SELECT action_key, updated_at
    FROM public.fulfillment_actions
    WHERE status IN ('succeeded', 'failed')
      AND updated_at < clock_timestamp() - make_interval(days => retention_days)
    ORDER BY updated_at, action_key
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  ) AS candidate;

  IF candidate_keys IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  DELETE FROM public.fulfillment_action_aliases AS alias
  WHERE EXISTS (
      SELECT 1 FROM public.fulfillment_actions AS candidate
      WHERE candidate.action_key = ANY(candidate_keys)
        AND candidate.provider = alias.provider
        AND candidate.scope = alias.scope
        AND candidate.source_order_id = alias.source_order_id
        AND candidate.action_name = alias.action_name
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.fulfillment_actions AS retained
      WHERE retained.action_key <> ALL(candidate_keys)
        AND retained.provider = alias.provider
        AND retained.scope = alias.scope
        AND retained.source_order_id = alias.source_order_id
        AND retained.action_name = alias.action_name
    );
  GET DIAGNOSTICS aliases_deleted = ROW_COUNT;

  DELETE FROM public.fulfillment_evidence_claims AS evidence
  WHERE EXISTS (
      SELECT 1 FROM public.fulfillment_actions AS candidate
      WHERE candidate.action_key = ANY(candidate_keys)
        AND candidate.attempt_id = evidence.attempt_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.fulfillment_actions AS retained
      WHERE retained.action_key <> ALL(candidate_keys)
        AND retained.attempt_id = evidence.attempt_id
    );
  GET DIAGNOSTICS evidence_deleted = ROW_COUNT;

  DELETE FROM public.fulfillment_actions
  WHERE action_key = ANY(candidate_keys);
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.delete_retained_fulfillment_actions(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_retained_fulfillment_actions(integer, integer)
  TO battle_bus_runtime;

COMMENT ON COLUMN public.fulfillment_actions.unresolved_since IS
  'Stable start of the current unresolved period; retries must not reset this timestamp.';
COMMENT ON COLUMN public.fulfillment_actions.last_unresolved_alert_at IS
  'Last durable operator alert for the current unresolved period.';
