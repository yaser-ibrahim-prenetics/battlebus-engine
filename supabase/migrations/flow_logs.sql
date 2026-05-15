-- Flow Logs table for structured event logging from Inngest functions and API clients.
-- Written to by supabase-flow-logs.ts (service-role), read by Battle Hub (anon key).

CREATE TABLE IF NOT EXISTS flow_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ts          timestamptz NOT NULL DEFAULT now(),
  level       text        NOT NULL DEFAULT 'info',
  flow        text        NOT NULL,
  step        text,
  client      text,
  run_id      text,
  request_id  text,
  shopify_order_id   text,
  shopify_order_name text,
  d365_order_number  text,
  status      text,
  duration_ms integer,
  error_type  text,
  error_message text,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Single-column indexes for common filter/sort patterns
CREATE INDEX IF NOT EXISTS idx_flow_logs_ts               ON flow_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_flow_logs_flow             ON flow_logs (flow);
CREATE INDEX IF NOT EXISTS idx_flow_logs_level            ON flow_logs (level);
CREATE INDEX IF NOT EXISTS idx_flow_logs_run_id           ON flow_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_id ON flow_logs (shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_flow_logs_shopify_order_name ON flow_logs (shopify_order_name);
CREATE INDEX IF NOT EXISTS idx_flow_logs_d365_order_number  ON flow_logs (d365_order_number);

-- Composite index for per-order timeline queries
CREATE INDEX IF NOT EXISTS idx_flow_logs_order_ts ON flow_logs (shopify_order_name, ts DESC);

-- Retention cleanup: oldest rows by ts
CREATE INDEX IF NOT EXISTS idx_flow_logs_ts_asc ON flow_logs (ts ASC);