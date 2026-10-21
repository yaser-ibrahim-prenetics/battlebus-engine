DO $$
BEGIN
  IF has_table_privilege('service_role', 'public.cutover_evidence', 'UPDATE')
    OR has_table_privilege('service_role', 'public.cutover_evidence', 'DELETE')
    OR has_table_privilege('battle_hub_runtime', 'public.cutover_evidence', 'SELECT') THEN
    RAISE EXCEPTION 'Cutover evidence privileges are too broad';
  END IF;
  IF has_table_privilege('service_role', 'public.cutover_evidence', 'INSERT')
    OR has_table_privilege('battle_bus_runtime', 'public.cutover_evidence', 'INSERT')
    OR pg_has_role('battle_bus_runtime', 'battle_bus_replay_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'Runtime must not write replay evidence';
  END IF;
  IF NOT has_table_privilege('battle_bus_replay_writer', 'public.cutover_evidence', 'INSERT') THEN
    RAISE EXCEPTION 'Replay evidence cannot be persisted';
  END IF;
END
$$;
SET LOCAL ROLE battle_bus_replay_writer;
INSERT INTO public.cutover_evidence
  (id, case_id, workflow_id, mode, provenance, source_reference, captured_at,
   input_hash, spock_revision, bus_revision, status, differences, spock_hash, bus_hash, started_at, completed_at)
VALUES ('00000000-0000-0000-0000-000000000036', 'fixture', 'shopify:orders/paid',
  'contract', 'synthetic', 'fixture:local', now(), repeat('a',64), repeat('b',40), repeat('c',40),
  'matched', '[]', repeat('d',64), repeat('d',64), now(), now());
DO $$
BEGIN
  BEGIN
    INSERT INTO public.cutover_evidence
      (id, case_id, workflow_id, mode, provenance, source_reference, captured_at,
       input_hash, spock_revision, bus_revision, status, differences, spock_hash, bus_hash, started_at, completed_at)
    VALUES ('00000000-0000-0000-0000-000000000037', 'invalid', 'shopify:orders/paid',
      'contract', 'synthetic', 'fixture:local', now(), repeat('a',64), repeat('b',40), repeat('c',40),
      'matched', '[]', repeat('d',64), repeat('e',64), now(), now());
    RAISE EXCEPTION 'Unequal output hashes passed as matched';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;
RESET ROLE;
