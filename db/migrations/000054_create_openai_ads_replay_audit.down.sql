BEGIN;

DROP POLICY openai_ads_replay_runtime ON public.openai_ads_replay_requests;
REVOKE SELECT, INSERT ON public.openai_ads_replay_requests FROM battle_bus_runtime;
REVOKE UPDATE (status, error_code, completed_at)
  ON public.openai_ads_replay_requests FROM battle_bus_runtime;
DROP TABLE public.openai_ads_replay_requests;

COMMIT;
