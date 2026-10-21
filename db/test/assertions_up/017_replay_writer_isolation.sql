SET LOCAL ROLE battle_bus_runtime;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.cutover_evidence
      (id, case_id, workflow_id, mode, provenance, source_reference, captured_at,
       input_hash, spock_revision, bus_revision, status, differences, spock_hash, bus_hash, started_at, completed_at)
    VALUES ('00000000-0000-0000-0000-000000000044', 'forged', 'shopify:orders/paid',
      'contract', 'synthetic', 'fixture:local', now(), repeat('a',64), repeat('b',40), repeat('c',40),
      'matched', '[]', repeat('d',64), repeat('d',64), now(), now());
    RAISE EXCEPTION 'Runtime forged independent parity evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;
DO $$
BEGIN
  IF has_table_privilege('battle_bus_replay_writer', 'public.cutover_evidence', 'UPDATE')
    OR has_table_privilege('battle_bus_replay_writer', 'public.cutover_evidence', 'DELETE')
    OR has_table_privilege('battle_bus_replay_writer', 'public.cutover_evidence', 'SELECT')
    OR has_table_privilege('battle_bus_replay_writer', 'public.orders', 'INSERT') THEN
    RAISE EXCEPTION 'Replay writer has privileges beyond evidence insertion';
  END IF;
END
$$;
