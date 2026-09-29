BEGIN;

CREATE TABLE IF NOT EXISTS public.refund_operations (
  refund_id text PRIMARY KEY,
  shopify_order_id text NOT NULL,
  event_name text NOT NULL DEFAULT 'shopify/refund.created',
  event_data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'processing',
  attempts integer NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  resume_state text,
  external_idempotency_key text UNIQUE,
  d365_order_number text,
  inventory_lot_id text,
  last_error text,
  line_created_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  backfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_operations_state_valid
    CHECK (state IN ('awaiting_order', 'dispatching', 'processing', 'creating_line', 'line_created', 'completed', 'dead_letter')),
  CONSTRAINT refund_operations_resume_state_valid
    CHECK (resume_state IS NULL OR resume_state IN ('processing', 'creating_line', 'line_created')),
  CONSTRAINT refund_operations_event_name_valid
    CHECK (event_name = 'shopify/refund.created'),
  CONSTRAINT refund_operations_attempts_positive CHECK (attempts > 0),
  CONSTRAINT refund_operations_event_data_object CHECK (jsonb_typeof(event_data) = 'object'),
  CONSTRAINT refund_operations_claim_consistent
    CHECK (
      (
        state IN ('processing', 'creating_line', 'line_created')
        AND claim_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND resume_state IS NULL
      )
      OR
      (
        state = 'dispatching'
        AND claim_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND resume_state IS NOT NULL
      )
      OR
      (
        state IN ('awaiting_order', 'completed', 'dead_letter')
        AND claim_token IS NULL
        AND lease_expires_at IS NULL
        AND resume_state IS NULL
      )
    ),
  CONSTRAINT refund_operations_completed_payload_scrubbed
    CHECK (state NOT IN ('completed', 'dead_letter') OR event_data = '{}'::jsonb),
  CONSTRAINT refund_operations_dead_letter_timestamp_consistent
    CHECK ((state = 'dead_letter') = (dead_lettered_at IS NOT NULL))
);

COMMENT ON TABLE public.refund_operations IS
  'Database-enforced refund deduplication and recovery ledger keyed by Shopify refund ID.';
COMMENT ON COLUMN public.refund_operations.event_data IS
  'Retained only while a refund is active and scrubbed when processing completes.';
COMMENT ON COLUMN public.refund_operations.state IS
  'Recoverable refund state machine. completed and dead_letter are terminal and carry no event payload.';

COMMIT;
