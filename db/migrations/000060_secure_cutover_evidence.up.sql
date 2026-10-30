BEGIN;
ALTER TABLE public.cutover_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cutover_evidence FROM PUBLIC, anon, authenticated, battle_hub_runtime, service_role;
GRANT SELECT, INSERT ON public.cutover_evidence TO service_role;
CREATE POLICY cutover_evidence_read ON public.cutover_evidence FOR SELECT TO service_role USING (true);
CREATE POLICY cutover_evidence_insert ON public.cutover_evidence FOR INSERT TO service_role WITH CHECK (true);
COMMIT;
