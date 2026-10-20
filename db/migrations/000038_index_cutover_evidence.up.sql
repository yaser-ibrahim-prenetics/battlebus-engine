BEGIN;
CREATE INDEX cutover_evidence_revision ON public.cutover_evidence (spock_revision, bus_revision, workflow_id, mode, recorded_at);
COMMIT;

