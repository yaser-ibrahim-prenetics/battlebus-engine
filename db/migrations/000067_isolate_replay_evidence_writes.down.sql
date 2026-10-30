BEGIN;
REVOKE INSERT ON public.cutover_evidence FROM battle_bus_replay_writer;
GRANT INSERT ON public.cutover_evidence TO service_role;
DROP POLICY cutover_evidence_insert ON public.cutover_evidence;
CREATE POLICY cutover_evidence_insert ON public.cutover_evidence
  FOR INSERT TO service_role WITH CHECK (true);
COMMIT;
