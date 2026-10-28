export const observeWorkflowSQL = `INSERT INTO public.workflow_observations (run_id,function_id,event_id)
  VALUES ($1,$2,$3) ON CONFLICT(run_id) DO UPDATE SET last_seen_at=now()`;
export const waitWorkflowSQL = `UPDATE public.workflow_observations SET
  waiting_until=GREATEST(waiting_until,$2::timestamptz), unknown_wait=unknown_wait OR $3,
  last_seen_at=now() WHERE run_id=$1`;
export const completeWorkflowSQL = `UPDATE public.workflow_observations SET completed_at=now(),last_seen_at=now()
  WHERE run_id=$1 AND completed_at IS NULL`;
export const staleWorkflowsSQL = `SELECT run_id,function_id,event_id,last_seen_at,waiting_until,unknown_wait
  FROM public.workflow_observations WHERE completed_at IS NULL AND last_seen_at<now()-interval '30 minutes'
  AND (waiting_until IS NULL OR waiting_until<now()-interval '5 minutes')
  ORDER BY last_seen_at LIMIT 26`;
export const cancellableWorkflowSQL = `SELECT run_id FROM public.workflow_observations WHERE run_id=$1
  AND completed_at IS NULL AND NOT unknown_wait AND last_seen_at<now()-interval '30 minutes'
  AND (waiting_until IS NULL OR waiting_until<now()-interval '5 minutes')`;
export const abandonedReconciliationSQL = `SELECT workflow_run_id FROM public.reconciliation_attempts
  WHERE id=$1 AND status='running' AND started_at<now()-interval '30 minutes'`;
export const closeAbandonedReconciliationSQL = `WITH legacy AS (
  UPDATE public.d365_reconciliation_runs SET status='failed',error_code='workflow_ended_without_completion',completed_at=now()
  WHERE id=$1 AND status='running' RETURNING id
) UPDATE public.reconciliation_attempts
  SET status='failed',error_code='workflow_ended_without_completion',completed_at=now()
  WHERE id=$1 AND status='running' RETURNING id`;
