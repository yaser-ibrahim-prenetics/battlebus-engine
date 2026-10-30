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

CREATE TABLE public.fulfillment_action_tombstones (
  action_key text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('gps', 'dynamics', 'shopify')),
  scope text NOT NULL,
  source_order_id text NOT NULL,
  source_line_id text NOT NULL,
  action_name text NOT NULL,
  request_hash text NOT NULL,
  attempt_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'succeeded' CHECK (status = 'succeeded'),
  result jsonb NOT NULL CHECK (octet_length(result::text) <= 2048),
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fulfillment_action_tombstones_source
  ON public.fulfillment_action_tombstones (
    provider, scope, source_order_id, source_line_id, action_name
  );

ALTER TABLE public.fulfillment_action_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_action_tombstones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fulfillment_action_tombstones TO battle_bus_runtime;
CREATE POLICY fulfillment_action_tombstones_runtime
  ON public.fulfillment_action_tombstones FOR SELECT TO battle_bus_runtime
  USING (true);

COMMENT ON TABLE public.fulfillment_action_tombstones IS
  'Immutable minimal replay evidence retained after active successful actions age out.';

CREATE TABLE public.fulfillment_housekeeping_successor (
  singleton_name text PRIMARY KEY
    CHECK (singleton_name = 'fulfillment-actions'),
  claim_id uuid NOT NULL UNIQUE,
  root_run_id text NOT NULL CHECK (length(root_run_id) BETWEEN 1 AND 512),
  batch integer NOT NULL CHECK (batch BETWEEN 1 AND 1000000),
  publish_after timestamptz NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (claim_expires_at > publish_after),
  CHECK (published_at IS NULL OR published_at >= publish_after)
);

ALTER TABLE public.fulfillment_housekeeping_successor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_housekeeping_successor FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.fulfillment_housekeeping_successor IS
  'Singleton durable claim preventing duplicate delayed fulfillment-housekeeping successors.';

CREATE TABLE public.fulfillment_action_housekeeping_quarantine (
  action_key text PRIMARY KEY,
  reason_code text NOT NULL CHECK (reason_code = 'unsupported_replay_result'),
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fulfillment_action_housekeeping_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_action_housekeeping_quarantine
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.fulfillment_action_housekeeping_quarantine IS
  'Terminal rows retained for operator review when permanent replay minimization fails closed.';

CREATE TABLE public.fulfillment_housekeeping_run_receipts (
  root_run_id text NOT NULL CHECK (length(root_run_id) BETWEEN 1 AND 512),
  batch integer NOT NULL CHECK (batch BETWEEN 0 AND 999999),
  deleted integer NOT NULL CHECK (deleted BETWEEN 0 AND 100),
  aliases_deleted integer NOT NULL DEFAULT 0 CHECK (aliases_deleted >= 0),
  evidence_deleted integer NOT NULL DEFAULT 0 CHECK (evidence_deleted >= 0),
  quarantined integer NOT NULL DEFAULT 0 CHECK (quarantined BETWEEN 0 AND 100),
  alerts_enqueued integer NOT NULL CHECK (alerts_enqueued BETWEEN 0 AND 200),
  has_more boolean NOT NULL,
  successor_claim_id uuid,
  successor_root_run_id text,
  successor_batch integer,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_run_id, batch),
  CHECK (
    (successor_claim_id IS NULL AND successor_root_run_id IS NULL AND successor_batch IS NULL)
    OR (
      successor_claim_id IS NOT NULL
      AND length(successor_root_run_id) BETWEEN 1 AND 512
      AND successor_batch BETWEEN 1 AND 1000000
    )
  )
);

ALTER TABLE public.fulfillment_housekeeping_run_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_housekeeping_run_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fulfillment_housekeeping_run_receipts TO battle_bus_runtime;
CREATE POLICY fulfillment_housekeeping_run_receipts_runtime
  ON public.fulfillment_housekeeping_run_receipts FOR SELECT TO battle_bus_runtime
  USING (true);

COMMENT ON TABLE public.fulfillment_housekeeping_run_receipts IS
  'Bounded retry receipts for housekeeping batches with ambiguous commit acknowledgements.';

CREATE FUNCTION public.minimize_fulfillment_action_replay_result(
  replay_provider text,
  replay_action_name text,
  replay_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  scalar_value text;
BEGIN
  IF replay_result IS NULL THEN
    RAISE EXCEPTION 'Successful fulfillment replay result is required'
      USING ERRCODE = '22023';
  END IF;

  IF replay_provider = 'gps' AND replay_action_name = 'create_outbound_order' THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(replay_result->'orderNo') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'orderNo')), 0) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(replay_result->'logisticsChannel') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'logisticsChannel')), 0) NOT BETWEEN 1 AND 128
    THEN
      RAISE EXCEPTION 'Invalid GPS outbound replay result' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'orderNo', trim(replay_result->>'orderNo'),
      'logisticsChannel', trim(replay_result->>'logisticsChannel')
    );
  ELSIF replay_provider = 'gps' AND replay_action_name LIKE 'cancel:%' THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR replay_result->>'cancelled' IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'Invalid GPS cancellation replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"cancelled":true}'::jsonb;
  ELSIF replay_provider = 'shopify' AND replay_action_name LIKE 'split:%' THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(replay_result->'selectedId') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'selectedId')), 0) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(replay_result->'remainderId') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'remainderId')), 0) NOT BETWEEN 1 AND 256
    THEN
      RAISE EXCEPTION 'Invalid Shopify split replay result' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'selectedId', trim(replay_result->>'selectedId'),
      'remainderId', trim(replay_result->>'remainderId')
    );
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name ~ '^(shipment|return):'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR replay_result->>'status' IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'Invalid D365 fulfillment replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"status":1,"Message":"FULFILMENT_ACCEPTED","Result":"FULFILMENT_ACCEPTED","$id":"replayed"}'::jsonb;
  ELSIF replay_provider = 'dynamics'
    AND (
      replay_action_name ~ '^segment-[0-9]+:(header|line:.*)$'
      OR replay_action_name ~ '^refund:[^:]+:line$'
    )
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid D365 identifier replay result' USING ERRCODE = '22023';
    END IF;
    scalar_value := trim(replay_result #>> '{}');
    IF COALESCE(length(scalar_value), 0) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'Invalid D365 identifier replay result' USING ERRCODE = '22023';
    END IF;
    RETURN to_jsonb(scalar_value);
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name ~ '^segment-[0-9]+:confirm$'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR replay_result->>'confirmed' IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'Invalid D365 confirmation replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"confirmed":true}'::jsonb;
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name ~ '^segment-[0-9]+:prepayment$'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR replay_result->>'posted' IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'Invalid D365 prepayment replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"posted":true}'::jsonb;
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name LIKE 'oos-recovery-line:%'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(replay_result->'InventoryLotId') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'InventoryLotId')), 0) NOT BETWEEN 1 AND 512
    THEN
      RAISE EXCEPTION 'Invalid D365 recovery-line replay result' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('InventoryLotId', trim(replay_result->>'InventoryLotId'));
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name = 'oos-recovery-confirm'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(replay_result->'response') IS DISTINCT FROM 'object'
      OR replay_result->'response'->>'status' IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'Invalid D365 recovery-confirm replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"response":{"status":1,"Message":"CONFIRMED","Result":"CONFIRMED","$id":"replayed"},"request":{}}'::jsonb;
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name = 'oos-recovery-prepayment'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(replay_result->'response') IS DISTINCT FROM 'object'
      OR replay_result->'response'->>'status' IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'Invalid D365 recovery-prepayment replay result' USING ERRCODE = '22023';
    END IF;
    RETURN '{"response":{"status":1,"Message":"PREPAYMENT_POSTED","Result":"PREPAYMENT_POSTED","$id":"replayed"},"request":{}}'::jsonb;
  ELSIF replay_provider = 'dynamics'
    AND replay_action_name ~ '^refund:[^:]+:invoice$'
  THEN
    IF jsonb_typeof(replay_result) IS DISTINCT FROM 'object'
      OR replay_result->>'success' IS DISTINCT FROM 'true'
      OR replay_result->>'skipped' IS DISTINCT FROM 'false'
      OR jsonb_typeof(replay_result->'creditNoteNumber') IS DISTINCT FROM 'string'
      OR COALESCE(length(trim(replay_result->>'creditNoteNumber')), 0) NOT BETWEEN 1 AND 256
    THEN
      RAISE EXCEPTION 'Invalid D365 refund-invoice replay result' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'creditNoteNumber', trim(replay_result->>'creditNoteNumber'),
      'success', true,
      'skipped', false
    );
  END IF;

  RAISE EXCEPTION 'No permanent replay codec for provider/action combination'
    USING ERRCODE = '22023';
END
$$;

REVOKE ALL ON FUNCTION public.minimize_fulfillment_action_replay_result(text, text, jsonb)
  FROM PUBLIC, anon, authenticated, battle_bus_runtime;

CREATE FUNCTION public.claim_fulfillment_housekeeping_successor(
  requested_root_run_id text,
  requested_batch integer,
  delay_minutes integer,
  lease_minutes integer
)
RETURNS TABLE (
  successor_claim_id uuid,
  successor_publish_after timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed_at timestamptz := clock_timestamp();
  new_claim_id uuid := gen_random_uuid();
  claimed_id uuid;
  claimed_publish_after timestamptz;
BEGIN
  IF requested_root_run_id IS NULL
    OR length(requested_root_run_id) < 1
    OR length(requested_root_run_id) > 512
  THEN
    RAISE EXCEPTION 'requested_root_run_id must contain between 1 and 512 characters'
      USING ERRCODE = '22023';
  END IF;
  IF requested_batch IS NULL OR requested_batch < 1 OR requested_batch > 1000000 THEN
    RAISE EXCEPTION 'requested_batch must be between 1 and 1000000'
      USING ERRCODE = '22023';
  END IF;
  IF delay_minutes IS NULL OR delay_minutes < 1 OR delay_minutes > 60 THEN
    RAISE EXCEPTION 'delay_minutes must be between 1 and 60'
      USING ERRCODE = '22023';
  END IF;
  IF lease_minutes IS NULL OR lease_minutes <= delay_minutes OR lease_minutes > 1440 THEN
    RAISE EXCEPTION 'lease_minutes must be greater than delay_minutes and at most 1440'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.fulfillment_housekeeping_successor AS successor (
    singleton_name,
    claim_id,
    root_run_id,
    batch,
    publish_after,
    claim_expires_at
  ) VALUES (
    'fulfillment-actions',
    new_claim_id,
    requested_root_run_id,
    requested_batch,
    claimed_at + make_interval(mins => delay_minutes),
    claimed_at + make_interval(mins => lease_minutes)
  )
  ON CONFLICT (singleton_name) DO UPDATE
  SET claim_id = EXCLUDED.claim_id,
      root_run_id = EXCLUDED.root_run_id,
      batch = EXCLUDED.batch,
      publish_after = EXCLUDED.publish_after,
      claim_expires_at = EXCLUDED.claim_expires_at,
      published_at = NULL,
      created_at = claimed_at
  WHERE successor.claim_expires_at <= claimed_at
  RETURNING successor.claim_id, successor.publish_after
  INTO claimed_id, claimed_publish_after;

  IF claimed_id IS NOT NULL THEN
    successor_claim_id := claimed_id;
    successor_publish_after := claimed_publish_after;
    RETURN NEXT;
  END IF;
END
$$;

CREATE FUNCTION public.authorize_fulfillment_housekeeping_successor(
  requested_claim_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF requested_claim_id IS NULL THEN
    RAISE EXCEPTION 'requested_claim_id is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fulfillment_housekeeping_successor
  SET published_at = COALESCE(published_at, clock_timestamp())
  WHERE claim_id = requested_claim_id
    AND publish_after <= clock_timestamp()
    AND (published_at IS NOT NULL OR claim_expires_at > clock_timestamp());
  RETURN FOUND;
END
$$;

CREATE FUNCTION public.consume_fulfillment_housekeeping_successor(
  requested_claim_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF requested_claim_id IS NULL THEN
    RAISE EXCEPTION 'requested_claim_id is required' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.fulfillment_housekeeping_successor
  WHERE claim_id = requested_claim_id
    AND published_at IS NOT NULL;
  RETURN FOUND;
END
$$;

CREATE FUNCTION public.record_fulfillment_housekeeping_run_receipt(
  requested_root_run_id text,
  requested_batch integer,
  requested_deleted integer,
  requested_aliases_deleted integer,
  requested_evidence_deleted integer,
  requested_quarantined integer,
  requested_alerts_enqueued integer,
  requested_has_more boolean,
  requested_successor_claim_id uuid,
  requested_successor_root_run_id text,
  requested_successor_batch integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF requested_root_run_id IS NULL
    OR length(requested_root_run_id) < 1
    OR length(requested_root_run_id) > 512
    OR requested_batch IS NULL
    OR requested_batch < 0
    OR requested_batch > 999999
  THEN
    RAISE EXCEPTION 'Invalid fulfillment housekeeping receipt identity'
      USING ERRCODE = '22023';
  END IF;
  IF requested_deleted IS NULL OR requested_deleted < 0 OR requested_deleted > 100
    OR requested_aliases_deleted IS NULL OR requested_aliases_deleted < 0
    OR requested_evidence_deleted IS NULL OR requested_evidence_deleted < 0
    OR requested_quarantined IS NULL OR requested_quarantined < 0
      OR requested_quarantined > 100
    OR requested_alerts_enqueued IS NULL OR requested_alerts_enqueued < 0
      OR requested_alerts_enqueued > 200
    OR requested_has_more IS NULL
  THEN
    RAISE EXCEPTION 'Invalid fulfillment housekeeping receipt result'
      USING ERRCODE = '22023';
  END IF;
  IF (
    requested_successor_claim_id IS NULL
    OR requested_successor_root_run_id IS NULL
    OR requested_successor_batch IS NULL
  ) AND NOT (
    requested_successor_claim_id IS NULL
    AND requested_successor_root_run_id IS NULL
    AND requested_successor_batch IS NULL
  ) THEN
    RAISE EXCEPTION 'Incomplete fulfillment housekeeping successor receipt'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.fulfillment_housekeeping_run_receipts (
    root_run_id,
    batch,
    deleted,
    aliases_deleted,
    evidence_deleted,
    quarantined,
    alerts_enqueued,
    has_more,
    successor_claim_id,
    successor_root_run_id,
    successor_batch
  ) VALUES (
    requested_root_run_id,
    requested_batch,
    requested_deleted,
    requested_aliases_deleted,
    requested_evidence_deleted,
    requested_quarantined,
    requested_alerts_enqueued,
    requested_has_more,
    requested_successor_claim_id,
    requested_successor_root_run_id,
    requested_successor_batch
  )
  ON CONFLICT (root_run_id, batch) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.fulfillment_housekeeping_run_receipts
    WHERE root_run_id = requested_root_run_id
      AND batch = requested_batch
      AND deleted = requested_deleted
      AND aliases_deleted = requested_aliases_deleted
      AND evidence_deleted = requested_evidence_deleted
      AND quarantined = requested_quarantined
      AND alerts_enqueued = requested_alerts_enqueued
      AND has_more = requested_has_more
      AND successor_claim_id IS NOT DISTINCT FROM requested_successor_claim_id
      AND successor_root_run_id IS NOT DISTINCT FROM requested_successor_root_run_id
      AND successor_batch IS NOT DISTINCT FROM requested_successor_batch
  ) THEN
    RAISE EXCEPTION 'Fulfillment housekeeping receipt mismatch'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.fulfillment_housekeeping_run_receipts
  WHERE ctid IN (
    SELECT ctid
    FROM public.fulfillment_housekeeping_run_receipts
    WHERE committed_at < clock_timestamp() - interval '90 days'
    ORDER BY committed_at
    LIMIT 100
  );
END
$$;

REVOKE ALL ON FUNCTION public.claim_fulfillment_housekeeping_successor(
  text, integer, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_fulfillment_housekeeping_successor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_fulfillment_housekeeping_successor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_fulfillment_housekeeping_run_receipt(
  text, integer, integer, integer, integer, integer, integer, boolean, uuid, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_fulfillment_housekeeping_successor(
  text, integer, integer, integer
) TO battle_bus_runtime;
GRANT EXECUTE ON FUNCTION public.authorize_fulfillment_housekeeping_successor(uuid)
  TO battle_bus_runtime;
GRANT EXECUTE ON FUNCTION public.consume_fulfillment_housekeeping_successor(uuid)
  TO battle_bus_runtime;
GRANT EXECUTE ON FUNCTION public.record_fulfillment_housekeeping_run_receipt(
  text, integer, integer, integer, integer, integer, integer, boolean, uuid, text, integer
) TO battle_bus_runtime;

CREATE FUNCTION public.delete_retained_fulfillment_actions(
  retention_days integer,
  batch_size integer
)
RETURNS TABLE (
  deleted integer,
  aliases_deleted integer,
  evidence_deleted integer,
  quarantined integer,
  quarantined_action_keys text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_keys text[];
  deletable_keys text[];
  candidate_action record;
  minimized_result jsonb;
BEGIN
  IF retention_days IS NULL OR retention_days < 90 OR retention_days > 3650 THEN
    RAISE EXCEPTION 'retention_days must be between 90 and 3650'
      USING ERRCODE = '22023';
  END IF;
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 100 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(candidate_row.action_key ORDER BY candidate_row.updated_at, candidate_row.action_key)
  INTO candidate_keys
  FROM (
    SELECT action_key, updated_at
    FROM public.fulfillment_actions
    WHERE status IN ('succeeded', 'failed')
      AND updated_at < clock_timestamp() - make_interval(days => retention_days)
      AND NOT EXISTS (
        SELECT 1 FROM public.fulfillment_action_housekeeping_quarantine AS quarantine
        WHERE quarantine.action_key = fulfillment_actions.action_key
      )
    ORDER BY updated_at, action_key
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  ) AS candidate_row;

  IF candidate_keys IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, 0, ARRAY[]::text[];
    RETURN;
  END IF;

  quarantined := 0;
  quarantined_action_keys := ARRAY[]::text[];
  FOR candidate_action IN
    SELECT action.*
    FROM public.fulfillment_actions AS action
    WHERE action.action_key = ANY(candidate_keys)
      AND action.status = 'succeeded'
    ORDER BY action.updated_at, action.action_key
  LOOP
    BEGIN
      minimized_result := public.minimize_fulfillment_action_replay_result(
        candidate_action.provider, candidate_action.action_name, candidate_action.result
      );
      IF octet_length(minimized_result::text) > 2048 THEN
        RAISE EXCEPTION 'Minimized fulfillment replay result exceeds 2 KiB'
          USING ERRCODE = '22023';
      END IF;
    EXCEPTION
      WHEN invalid_parameter_value THEN
        INSERT INTO public.fulfillment_action_housekeeping_quarantine (
          action_key, reason_code
        ) VALUES (
          candidate_action.action_key, 'unsupported_replay_result'
        )
        ON CONFLICT (action_key) DO UPDATE
        SET last_seen_at = clock_timestamp();
        quarantined := quarantined + 1;
        quarantined_action_keys := array_append(
          quarantined_action_keys, candidate_action.action_key
        );
        CONTINUE;
    END;

    INSERT INTO public.fulfillment_action_tombstones (
      action_key, provider, scope, source_order_id, source_line_id,
      action_name, request_hash, attempt_id, status, result, created_at, completed_at
    ) VALUES (
      candidate_action.action_key,
      candidate_action.provider,
      candidate_action.scope,
      candidate_action.source_order_id,
      candidate_action.source_line_id,
      candidate_action.action_name,
      candidate_action.request_hash,
      candidate_action.attempt_id,
      candidate_action.status,
      minimized_result,
      candidate_action.created_at,
      candidate_action.updated_at
    )
    ON CONFLICT (action_key) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM public.fulfillment_action_tombstones AS tombstone
      WHERE tombstone.action_key = candidate_action.action_key
        AND tombstone.provider = candidate_action.provider
        AND tombstone.scope = candidate_action.scope
        AND tombstone.source_order_id = candidate_action.source_order_id
        AND tombstone.source_line_id = candidate_action.source_line_id
        AND tombstone.action_name = candidate_action.action_name
        AND tombstone.request_hash = candidate_action.request_hash
        AND tombstone.attempt_id = candidate_action.attempt_id
        AND tombstone.result = minimized_result
    ) THEN
      RAISE EXCEPTION 'Successful fulfillment action tombstone mismatch'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT array_agg(action.action_key ORDER BY action.updated_at, action.action_key)
  INTO deletable_keys
  FROM public.fulfillment_actions AS action
  WHERE action.action_key = ANY(candidate_keys)
    AND (
      action.status = 'failed'
      OR EXISTS (
        SELECT 1 FROM public.fulfillment_action_tombstones AS tombstone
        WHERE tombstone.action_key = action.action_key
      )
    );

  -- Aliases and provider evidence are compact idempotency/audit relationships.
  -- Keep them after active rows age out so cross-source replay remains blocked.
  aliases_deleted := 0;
  evidence_deleted := 0;

  DELETE FROM public.fulfillment_actions
  WHERE action_key = ANY(deletable_keys);
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
