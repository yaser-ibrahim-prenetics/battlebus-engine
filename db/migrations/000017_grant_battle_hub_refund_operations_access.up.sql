BEGIN;

REVOKE ALL ON TABLE public.battle_hub_refund_operations FROM PUBLIC;
GRANT SELECT ON TABLE public.battle_hub_refund_operations TO battle_hub_runtime;

COMMIT;
