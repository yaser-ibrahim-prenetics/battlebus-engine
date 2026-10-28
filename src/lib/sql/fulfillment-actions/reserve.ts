export const lockOrderSQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
export const readActionsSQL = `SELECT action_key, action_name, request_hash, attempt_id, status, result
  FROM public.fulfillment_actions
  WHERE provider = $1 AND scope = $2 AND source_order_id = $3
    AND (source_line_id = ANY($4::text[]) OR action_name = $5) FOR UPDATE`;
export const reserveActionSQL = `INSERT INTO public.fulfillment_actions
  (action_key, provider, scope, source_order_id, source_line_id, action_name, request_hash, attempt_id, status, recovery_context)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb)
  ON CONFLICT (action_key) DO UPDATE SET status='pending', attempt_id=EXCLUDED.attempt_id,
    request_hash=EXCLUDED.request_hash, recovery_context=EXCLUDED.recovery_context, attempts=fulfillment_actions.attempts+1, result=NULL, error_code=NULL, updated_at=now()
  WHERE fulfillment_actions.status='failed' RETURNING action_key`;
