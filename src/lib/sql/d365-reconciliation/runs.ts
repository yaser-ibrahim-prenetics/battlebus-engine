export const beginRunSQL = `INSERT INTO public.d365_reconciliation_runs
  (id, workflow_run_id, kind, shop_domain, dynamics_origin, range_start, range_end, status)
  VALUES ($1,$2,$3,$4,$5,$6,$7,'running')`;
export const completeRunSQL = `UPDATE public.d365_reconciliation_runs
  SET status=$2, result=$3::jsonb, error_code=$4, completed_at=now()
  WHERE id=$1 AND status='running' RETURNING id`;

export const beginDurableRunSQL = beginRunSQL + " ON CONFLICT (id) DO NOTHING";
export const completeDurableRunSQL = completeRunSQL.replace(
  "status='running'",
  "(status='running' OR (status=$2 AND result=$3::jsonb))"
);
