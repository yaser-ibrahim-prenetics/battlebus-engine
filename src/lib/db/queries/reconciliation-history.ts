export const reconciliationHistoryQueries = {
  start: `INSERT INTO public.reconciliation_history (
       audit_id,
       run_id,
       attempt,
       store_code,
       reconciliation_type,
       trigger_type,
       date_from,
       date_to,
       window_start,
       window_end_exclusive
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date, $9::timestamptz, $10::timestamptz)
     ON CONFLICT (run_id, reconciliation_type, attempt) DO UPDATE
     SET status = 'running',
         total_orders = 0,
         matched_orders = 0,
         discrepancy_count = 0,
         details = '{}'::jsonb,
         message = NULL,
         started_at = now(),
         completed_at = NULL,
         error = NULL,
         updated_at = now()
     RETURNING audit_id`,

  complete: `UPDATE public.reconciliation_history
     SET status = $2,
         total_orders = $3,
         matched_orders = $4,
         discrepancy_count = $5,
         details = $6::jsonb,
         message = $7,
         error = $8,
         completed_at = now(),
         updated_at = now()
     WHERE audit_id = $1::uuid
       AND status = 'running'
     RETURNING audit_id`,
} as const;
