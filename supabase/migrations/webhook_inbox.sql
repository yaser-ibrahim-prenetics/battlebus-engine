-- Webhook Inbox table — durability layer for inbound webhooks.
-- Every webhook (Shopify, GPS, GPS individual, STORD, Loop, Dynamics fulfilment)
-- is recorded here immediately after signature verification, BEFORE we attempt
-- to publish the corresponding event(s) to Inngest. This guarantees the raw
-- webhook is never lost even if the process crashes or inngest.send() fails.
--
-- Written to by src/lib/services/supabase-webhook-inbox.ts (service-role),
-- read by the same service (drain cron: src/inngest/functions/drain-webhook-inbox.ts)
-- to re-attempt publishing any row not yet marked "published".

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text        NOT NULL,
  topic        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb       NOT NULL,
  headers      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  events       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status       text        NOT NULL DEFAULT 'received',
  event_ids    text[],
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,
  published_at timestamptz
);

-- Common filter/sort patterns
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status      ON webhook_inbox (status);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_received_at ON webhook_inbox (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_source      ON webhook_inbox (source);
