BEGIN;

REVOKE SELECT ON TABLE public.battle_hub_refund_operations FROM battle_hub_runtime;

COMMIT;
