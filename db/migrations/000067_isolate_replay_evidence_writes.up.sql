BEGIN;
REVOKE INSERT ON public.cutover_evidence FROM service_role, battle_bus_runtime, battle_hub_runtime, PUBLIC, anon, authenticated;
GRANT INSERT ON public.cutover_evidence TO battle_bus_replay_writer;
DROP POLICY cutover_evidence_insert ON public.cutover_evidence;
CREATE POLICY cutover_evidence_insert ON public.cutover_evidence
  FOR INSERT TO battle_bus_replay_writer WITH CHECK (true);
COMMIT;
