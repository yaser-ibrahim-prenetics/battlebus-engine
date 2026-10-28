CREATE INDEX workflow_observations_active ON public.workflow_observations(last_seen_at) WHERE completed_at IS NULL;
