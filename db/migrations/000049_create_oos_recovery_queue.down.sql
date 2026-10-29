BEGIN;

REVOKE SELECT ON public.battle_hub_oos_recovery FROM battle_hub_runtime;
DROP VIEW public.battle_hub_oos_recovery;

DROP POLICY oos_outbox_runtime ON public.oos_recovery_outbox;
DROP POLICY oos_drain_commands_runtime ON public.oos_drain_command_receipts;
DROP POLICY oos_drain_requests_runtime ON public.oos_drain_requests;
DROP POLICY oos_dependencies_runtime ON public.oos_recovery_dependencies;

REVOKE SELECT, INSERT, UPDATE ON public.oos_recovery_outbox FROM battle_bus_runtime;
REVOKE SELECT, INSERT ON public.oos_drain_command_receipts FROM battle_bus_runtime;
REVOKE UPDATE (status, result_evidence, completed_at)
  ON public.oos_drain_command_receipts FROM battle_bus_runtime;
REVOKE SELECT, INSERT, UPDATE ON public.oos_drain_requests FROM battle_bus_runtime;
REVOKE SELECT, INSERT, UPDATE ON public.oos_recovery_dependencies FROM battle_bus_runtime;

DROP TRIGGER battle_platform_oos_outbox_updated_at ON public.oos_recovery_outbox;
DROP TRIGGER battle_platform_oos_drain_updated_at ON public.oos_drain_requests;
DROP TRIGGER battle_platform_oos_dependency_updated_at ON public.oos_recovery_dependencies;

DROP TABLE public.oos_recovery_outbox;
DROP TABLE public.oos_drain_command_receipts;
DROP TABLE public.oos_drain_requests;
DROP TABLE public.oos_recovery_dependencies;

COMMIT;
