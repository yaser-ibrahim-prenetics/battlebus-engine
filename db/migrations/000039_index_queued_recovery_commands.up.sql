CREATE INDEX recovery_commands_queued ON public.recovery_commands(created_at) WHERE status='queued';
