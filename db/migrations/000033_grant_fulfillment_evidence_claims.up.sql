ALTER TABLE public.fulfillment_evidence_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fulfillment_evidence_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.fulfillment_evidence_claims TO battle_bus_runtime;
CREATE POLICY fulfillment_evidence_claims_runtime ON public.fulfillment_evidence_claims
  FOR ALL TO battle_bus_runtime USING (true) WITH CHECK (true);
