export const workflowHealthQueries = {
  start: `INSERT INTO public.workflow_run_health (run_id, function_id, event_name, revision, received_at)
    VALUES ($1,$2,$3,$4,LEAST(now(),COALESCE($5::timestamptz,now())))
    ON CONFLICT (run_id) DO NOTHING`,
  finish: `UPDATE public.workflow_run_health
    SET status = $2, completed_at = now(), attempts = GREATEST(attempts, $3), sample_excluded = $4
    WHERE run_id = $1 AND status = 'running'`,
  retry: `UPDATE public.workflow_run_health SET attempts = GREATEST(attempts, $2)
    WHERE run_id = $1 AND status = 'running'`,
  report: `SELECT function_id,
    count(*) FILTER (WHERE NOT sample_excluded AND completed_at >= now() - interval '24 hours')::int AS completed,
    count(*) FILTER (WHERE NOT sample_excluded AND status = 'failed' AND completed_at >= now() - interval '24 hours')::int AS failed,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM completed_at - received_at))
      FILTER (WHERE NOT sample_excluded AND completed_at >= now() - interval '24 hours') AS latency_seconds,
    count(*) FILTER (WHERE status = 'running')::int AS backlog,
    COALESCE(max(EXTRACT(epoch FROM now() - received_at)) FILTER (WHERE status = 'running'),0) AS backlog_age_seconds
    FROM public.workflow_run_health
    WHERE revision = $1 AND (status = 'running' OR completed_at >= now() - interval '24 hours')
    GROUP BY function_id ORDER BY function_id`,
  outbox: `SELECT count(*) FILTER (WHERE state <> 'published')::int AS backlog,
    COALESCE(max(EXTRACT(epoch FROM now() - created_at)) FILTER (WHERE state <> 'published'),0) AS backlog_age_seconds,
    count(*) FILTER (WHERE state = 'dead_letter')::int AS dead_letters
    FROM public.event_outbox`,
} as const;
