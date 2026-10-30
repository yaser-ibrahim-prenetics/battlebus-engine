BEGIN;
DROP POLICY cutover_evidence_insert ON public.cutover_evidence;
DROP POLICY cutover_evidence_read ON public.cutover_evidence;
REVOKE SELECT, INSERT ON public.cutover_evidence FROM service_role;
ALTER TABLE public.cutover_evidence DISABLE ROW LEVEL SECURITY;
COMMIT;
