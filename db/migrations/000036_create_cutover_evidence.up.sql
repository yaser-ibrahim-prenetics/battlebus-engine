BEGIN;
CREATE TABLE public.cutover_evidence (
  id uuid PRIMARY KEY,
  case_id text NOT NULL,
  workflow_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('contract', 'historical', 'shadow', 'recovery')),
  provenance text NOT NULL CHECK (provenance IN ('synthetic', 'production')),
  source_reference text NOT NULL,
  captured_at timestamptz NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  spock_revision text NOT NULL CHECK (spock_revision ~ '^[a-f0-9]{40}$'),
  bus_revision text NOT NULL CHECK (bus_revision ~ '^[a-f0-9]{40}$'),
  status text NOT NULL CHECK (status IN ('matched', 'mismatch', 'error')),
  differences jsonb NOT NULL CHECK (jsonb_typeof(differences) = 'array'),
  spock_hash text,
  bus_hash text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'matched' OR
    (spock_hash IS NOT NULL AND bus_hash IS NOT NULL AND spock_hash = bus_hash AND differences = '[]'::jsonb))
);
COMMENT ON TABLE public.cutover_evidence IS
  'Append-only paired execution evidence. No raw customer payloads or provider responses.';
COMMIT;

