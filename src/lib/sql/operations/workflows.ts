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
