DO $$
BEGIN
  IF NOT has_table_privilege('battle_bus_runtime','public.fulfillment_evidence_claims','SELECT,INSERT') OR
     has_table_privilege('battle_bus_runtime','public.fulfillment_evidence_claims','UPDATE,DELETE') OR
     NOT has_table_privilege('battle_bus_runtime','public.recovery_commands','SELECT,INSERT') OR
     NOT has_column_privilege('battle_bus_runtime','public.recovery_commands','status','UPDATE') OR
     has_column_privilege('battle_bus_runtime','public.recovery_commands','actor_id','UPDATE') OR
     has_column_privilege('battle_bus_runtime','public.recovery_commands','parameters','UPDATE') OR
     has_table_privilege('authenticated','public.recovery_commands','SELECT') THEN
    RAISE EXCEPTION 'Recovery audit immutability/privilege contract failed';
  END IF;
END $$;
