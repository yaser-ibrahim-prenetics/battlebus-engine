export const insertChannelLiftRunSQL = `INSERT INTO public.channel_lift_runs
  (run_id, reporting_date, mode, source, request_id, requested_by, reason_code, reference_id)
  VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (reporting_date, mode) DO NOTHING
  RETURNING run_id`;

export const insertChannelLiftRunAttemptSQL = `INSERT INTO public.channel_lift_run_attempts
  (request_id, run_id, source, requested_by, reason_code, reference_id)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (request_id) DO NOTHING
  RETURNING request_id`;

export const readChannelLiftRunAttemptSQL = `SELECT run_id, source, requested_by,
    reason_code, reference_id
  FROM public.channel_lift_run_attempts WHERE request_id=$1`;

export const startChannelLiftRunSQL = `UPDATE public.channel_lift_runs
  SET status='running', attempts=attempts+1, started_at=clock_timestamp(),
    completed_at=NULL, last_error_code=NULL
  WHERE run_id=$1
    AND (status IN ('queued','failed')
      OR (status='running' AND updated_at < clock_timestamp()-interval '2 hours'))
    AND attempts < 100
  RETURNING run_id, reporting_date, mode, source, request_id, status, attempts,
    expected_rows, expected_orders, expected_pairs, mapped_pairs,
    eligible_events, exclusion_counts, batch_count, attempted_events,
    delivered_events, config_hash, snapshot_hash, last_error_code,
    eligibility_cutoff_seconds`;

export const readChannelLiftRunSQL = `SELECT run_id, reporting_date, mode, source, request_id, status,
    attempts, expected_rows, expected_orders, expected_pairs, mapped_pairs,
    eligible_events, exclusion_counts, batch_count, attempted_events,
    delivered_events, config_hash, snapshot_hash, last_error_code,
    eligibility_cutoff_seconds
  FROM public.channel_lift_runs WHERE run_id=$1`;

export const readActiveChannelLiftRunSQL = `SELECT run_id, reporting_date, mode, source, request_id, status,
    attempts, expected_rows, expected_orders, expected_pairs, mapped_pairs,
    eligible_events, exclusion_counts, batch_count, attempted_events,
    delivered_events, config_hash, snapshot_hash, last_error_code,
    eligibility_cutoff_seconds
  FROM public.channel_lift_runs
  WHERE reporting_date=$1::date AND status IN ('queued','running')
  ORDER BY created_at LIMIT 1`;

export const recordChannelLiftPreparedSQL = `UPDATE public.channel_lift_runs
  SET expected_rows=$2, expected_orders=$3, expected_pairs=$4,
    mapped_pairs=$5, eligible_events=$6, exclusion_counts=$7::jsonb,
    config_hash=$8, snapshot_hash=$9
  WHERE run_id=$1 AND status='running'
    AND (config_hash IS NULL OR config_hash=$8)
    AND (snapshot_hash IS NULL OR snapshot_hash=$9)
  RETURNING run_id`;

export const recordChannelLiftProgressSQL = `UPDATE public.channel_lift_runs
  SET batch_count=GREATEST(batch_count, $2),
    attempted_events=GREATEST(attempted_events, $3),
    delivered_events=GREATEST(delivered_events, $4)
  WHERE run_id=$1 AND status='running'
    AND $4 <= $3
    AND $3 <= COALESCE(eligible_events, $3)
  RETURNING run_id`;

export const completeChannelLiftRunSQL = `UPDATE public.channel_lift_runs
  SET status=$2, completed_at=clock_timestamp(), last_error_code=NULL
  WHERE run_id=$1 AND status='running'
  RETURNING run_id`;

export const failChannelLiftRunSQL = `UPDATE public.channel_lift_runs
  SET status='failed', completed_at=clock_timestamp(), last_error_code=$2
  WHERE run_id=$1 AND status='running'
  RETURNING run_id`;
