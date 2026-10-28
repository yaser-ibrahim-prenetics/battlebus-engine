CREATE TABLE public.fulfillment_evidence_claims (
  provider text NOT NULL,
  scope text NOT NULL,
  document_id text NOT NULL,
  attempt_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, scope, document_id)
);
