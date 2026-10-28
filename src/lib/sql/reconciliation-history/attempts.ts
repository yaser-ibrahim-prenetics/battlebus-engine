export const beginAttemptSQL = `INSERT INTO public.reconciliation_attempts
  (id, workflow_run_id, kind, scope, range_start, range_end, status)
  VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`;
export const finishAttemptSQL = `UPDATE public.reconciliation_attempts
  SET status=$2, result=$3::jsonb, error_code=$4, completed_at=now()
  WHERE id=$1 AND status='running' RETURNING id`;
export const recentAttemptsSQL = `SELECT * FROM public.reconciliation_attempts
  ORDER BY started_at DESC, id DESC LIMIT $1`;
