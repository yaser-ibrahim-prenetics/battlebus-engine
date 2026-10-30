export const createOpenAiAdsReplayRequestSQL = `INSERT INTO public.openai_ads_replay_requests
  (id, request_hash, event_id, actor_id, actor_email, reason)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (id) DO NOTHING`;

export const readOpenAiAdsReplayRequestSQL = `SELECT id, request_hash, event_id, status, error_code
  FROM public.openai_ads_replay_requests WHERE id=$1 FOR UPDATE`;

export const lockOpenAiAdsConversionSQL = `SELECT event_id, status, replay_count
  FROM public.openai_ads_conversions WHERE event_id=$1 FOR UPDATE`;

export const replayOpenAiAdsConversionSQL = `UPDATE public.openai_ads_conversions
  SET status='queued', attempts=0, next_attempt_at=clock_timestamp(),
    lease_token=NULL, lease_until=NULL, last_http_status=NULL,
    last_error_category=NULL, last_error=NULL, permanent_at=NULL,
    replay_count=replay_count+1, replayed_at=clock_timestamp()
  WHERE event_id=$1 AND status IN ('permanent_failure','skipped') AND replay_count<100
  RETURNING event_id`;

export const finishOpenAiAdsReplayRequestSQL = `UPDATE public.openai_ads_replay_requests
  SET status=$2, error_code=$3, completed_at=clock_timestamp()
  WHERE id=$1 AND status='pending' RETURNING id`;
