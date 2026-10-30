import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

/** A read-only DB round trip plus configuration checks, not provider write tests. */
export async function checkReadiness() {
  let database = false;
  const channelLiftEnabled = config.channelLift?.enabled === true;
  let channelLiftSchema = !channelLiftEnabled;
  const fulfillmentHousekeepingEnabled = config.fulfillmentActionHousekeeping?.enabled === true;
  let fulfillmentActionLedgerSchema = false;
  try {
    if (isDatabaseConfigured()) {
      await queryDatabase("SELECT 1 AS ready");
      database = true;
      if (channelLiftEnabled) {
        const result = await queryDatabase<{ ready: boolean }>(`SELECT
          to_regclass('public.channel_lift_runs') IS NOT NULL
          AND to_regclass('public.channel_lift_run_attempts') IS NOT NULL
          AND to_regclass('public.channel_lift_request_identities') IS NOT NULL
          AND to_regprocedure('public.battle_platform_enforce_channel_lift_transition()') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'public.channel_lift_runs'::regclass
              AND tgname = 'battle_platform_enforce_channel_lift_transition'
              AND tgfoid = 'public.battle_platform_enforce_channel_lift_transition()'::regprocedure
              AND tgenabled IN ('O', 'A')
              AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.channel_lift_runs'::regclass AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.channel_lift_run_attempts'::regclass AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.channel_lift_request_identities'::regclass AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'channel_lift_runs'
              AND policyname = 'channel_lift_runtime'
              AND 'battle_bus_runtime' = ANY(roles)
              AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
              AND qual = 'true' AND with_check = 'true'
          )
          AND EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'channel_lift_run_attempts'
              AND policyname = 'channel_lift_attempt_runtime'
              AND 'battle_bus_runtime' = ANY(roles)
              AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
              AND qual = 'true' AND with_check = 'true'
          )
          AND EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'channel_lift_request_identities'
              AND policyname = 'channel_lift_request_identity_runtime'
              AND 'battle_bus_runtime' = ANY(roles)
              AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
              AND qual = 'true' AND with_check = 'true'
          )
          AND (
            SELECT COUNT(*) = 6 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'channel_lift_runs'
              AND column_name IN (
                'request_id', 'reason_code', 'reference_id',
                'eligibility_cutoff_seconds', 'config_hash', 'snapshot_hash'
              )
          )
          AND (
            SELECT COUNT(*) = 8 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'channel_lift_run_attempts'
              AND column_name IN (
                'request_id', 'run_id', 'mode', 'source', 'requested_by',
                'reason_code', 'reference_id', 'requested_at'
              )
          )
          AND (
            SELECT COUNT(*) = 4 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'channel_lift_request_identities'
              AND column_name IN ('request_id', 'mode', 'source', 'first_seen_at')
          )
          AND (
            SELECT COUNT(*) = 3
            FROM pg_constraint
            WHERE contype = 'f' AND convalidated AND (
              (
                conrelid = 'public.channel_lift_runs'::regclass
                AND confrelid = 'public.channel_lift_request_identities'::regclass
                AND conname = 'channel_lift_runs_request_identity_fkey'
                AND pg_get_constraintdef(oid) LIKE
                  'FOREIGN KEY (request_id, mode, source) REFERENCES channel_lift_request_identities(request_id, mode, source)%'
              )
              OR (
                conrelid = 'public.channel_lift_run_attempts'::regclass
                AND confrelid = 'public.channel_lift_request_identities'::regclass
                AND conname = 'channel_lift_attempt_request_identity_fkey'
                AND pg_get_constraintdef(oid) LIKE
                  'FOREIGN KEY (request_id, mode, source) REFERENCES channel_lift_request_identities(request_id, mode, source)%'
              )
              OR (
                conrelid = 'public.channel_lift_run_attempts'::regclass
                AND confrelid = 'public.channel_lift_runs'::regclass
                AND conname = 'channel_lift_attempt_run_identity_fkey'
                AND pg_get_constraintdef(oid) LIKE
                  'FOREIGN KEY (run_id, mode) REFERENCES channel_lift_runs(run_id, mode)%'
              )
            )
          )
          AND has_table_privilege(current_user, 'public.channel_lift_runs', 'SELECT')
          AND has_table_privilege(current_user, 'public.channel_lift_runs', 'INSERT')
          AND has_table_privilege(current_user, 'public.channel_lift_run_attempts', 'SELECT')
          AND has_table_privilege(current_user, 'public.channel_lift_run_attempts', 'INSERT')
          AND has_table_privilege(current_user, 'public.channel_lift_request_identities', 'SELECT')
          AND has_table_privilege(current_user, 'public.channel_lift_request_identities', 'INSERT')
          AND (
            SELECT bool_and(has_column_privilege(
              current_user, 'public.channel_lift_runs', allowed.column_name, 'UPDATE'
            ))
            FROM unnest(ARRAY[
              'status', 'attempts', 'expected_rows', 'expected_orders', 'expected_pairs',
              'mapped_pairs', 'eligible_events', 'exclusion_counts', 'batch_count',
              'attempted_events', 'delivered_events', 'config_hash', 'snapshot_hash',
              'last_error_code', 'started_at', 'completed_at'
            ]) AS allowed(column_name)
          )
          AND NOT has_table_privilege(current_user, 'public.channel_lift_runs', 'UPDATE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_runs', 'DELETE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_runs', 'TRUNCATE')
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
              'run_id', 'reporting_date', 'mode', 'source', 'request_id',
              'requested_by', 'reason_code', 'reference_id',
              'eligibility_cutoff_seconds', 'created_at', 'updated_at'
            ]) AS immutable(column_name)
            WHERE has_column_privilege(
              current_user, 'public.channel_lift_runs', immutable.column_name, 'UPDATE'
            )
          )
          AND NOT has_any_column_privilege(current_user, 'public.channel_lift_run_attempts', 'UPDATE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_run_attempts', 'DELETE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_run_attempts', 'TRUNCATE')
          AND NOT has_any_column_privilege(current_user, 'public.channel_lift_request_identities', 'UPDATE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_request_identities', 'DELETE')
          AND NOT has_table_privilege(current_user, 'public.channel_lift_request_identities', 'TRUNCATE')
          AS ready`);
        channelLiftSchema = result.rows[0]?.ready === true;
      }
      {
        const result = await queryDatabase<{ ready: boolean }>(`SELECT
          to_regclass('public.fulfillment_action_tombstones') IS NOT NULL
          AND to_regclass('public.fulfillment_action_tombstones_source') IS NOT NULL
          AND to_regclass('public.fulfillment_housekeeping_successor') IS NOT NULL
          AND to_regclass('public.fulfillment_action_housekeeping_quarantine') IS NOT NULL
          AND to_regclass('public.fulfillment_housekeeping_run_receipts') IS NOT NULL
          AND to_regprocedure(
            'public.minimize_fulfillment_action_replay_result(text,text,jsonb)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.delete_retained_fulfillment_actions(integer,integer)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.authorize_fulfillment_housekeeping_successor(uuid)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.consume_fulfillment_housekeeping_successor(uuid)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.record_fulfillment_housekeeping_run_receipt(text,integer,integer,integer,integer,integer,integer,boolean,uuid,text,integer)'
          ) IS NOT NULL
          AND to_regprocedure(
            'public.battle_platform_track_fulfillment_unresolved_age()'
          ) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'public.fulfillment_actions'::regclass
              AND tgname = 'fulfillment_actions_track_unresolved_age'
              AND tgfoid =
                'public.battle_platform_track_fulfillment_unresolved_age()'::regprocedure
              AND tgenabled IN ('O', 'A')
              AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.fulfillment_actions'::regclass
              AND conname = 'fulfillment_actions_unresolved_age'
              AND convalidated
          )
          AND (
            SELECT proconfig = ARRAY['search_path=pg_catalog, public']::text[]
              AND NOT prosecdef
            FROM pg_proc
            WHERE oid =
              'public.minimize_fulfillment_action_replay_result(text,text,jsonb)'::regprocedure
          )
          AND (
            SELECT count(*) = 5 AND bool_and(
              prosecdef
              AND proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            )
            FROM pg_proc
            WHERE oid = ANY(ARRAY[
              'public.delete_retained_fulfillment_actions(integer,integer)'::regprocedure,
              'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)'::regprocedure,
              'public.authorize_fulfillment_housekeeping_successor(uuid)'::regprocedure,
              'public.consume_fulfillment_housekeeping_successor(uuid)'::regprocedure,
              'public.record_fulfillment_housekeeping_run_receipt(text,integer,integer,integer,integer,integer,integer,boolean,uuid,text,integer)'::regprocedure
            ])
          )
          AND EXISTS (
            SELECT 1 FROM pg_proc
            WHERE oid =
              'public.delete_retained_fulfillment_actions(integer,integer)'::regprocedure
              AND prosecdef
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.fulfillment_action_tombstones'::regclass AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.fulfillment_housekeeping_successor'::regclass AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.fulfillment_action_housekeeping_quarantine'::regclass
              AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = 'public.fulfillment_housekeeping_run_receipts'::regclass
              AND relrowsecurity
          )
          AND EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'fulfillment_action_tombstones'
              AND policyname = 'fulfillment_action_tombstones_runtime'
              AND 'battle_bus_runtime' = ANY(roles)
              AND cmd = 'SELECT'
              AND permissive = 'PERMISSIVE'
              AND qual = 'true'
          )
          AND EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'fulfillment_housekeeping_run_receipts'
              AND policyname = 'fulfillment_housekeeping_run_receipts_runtime'
              AND 'battle_bus_runtime' = ANY(roles)
              AND cmd = 'SELECT'
              AND permissive = 'PERMISSIVE'
              AND qual = 'true'
          )
          AND (
            SELECT count(*) = 2 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'fulfillment_actions'
              AND column_name IN ('unresolved_since', 'last_unresolved_alert_at')
          )
          AND has_function_privilege(
            'battle_bus_runtime',
            'public.delete_retained_fulfillment_actions(integer,integer)',
            'EXECUTE'
          )
          AND has_function_privilege(
            'battle_bus_runtime',
            'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)',
            'EXECUTE'
          )
          AND has_function_privilege(
            'battle_bus_runtime',
            'public.authorize_fulfillment_housekeeping_successor(uuid)',
            'EXECUTE'
          )
          AND has_function_privilege(
            'battle_bus_runtime',
            'public.consume_fulfillment_housekeeping_successor(uuid)',
            'EXECUTE'
          )
          AND has_function_privilege(
            'battle_bus_runtime',
            'public.record_fulfillment_housekeeping_run_receipt(text,integer,integer,integer,integer,integer,integer,boolean,uuid,text,integer)',
            'EXECUTE'
          )
          AND pg_has_role(current_user, 'battle_bus_runtime', 'MEMBER')
          AND has_function_privilege(
            current_user,
            'public.delete_retained_fulfillment_actions(integer,integer)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'public.authorize_fulfillment_housekeeping_successor(uuid)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'public.consume_fulfillment_housekeeping_successor(uuid)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'public.record_fulfillment_housekeeping_run_receipt(text,integer,integer,integer,integer,integer,integer,boolean,uuid,text,integer)',
            'EXECUTE'
          )
          AND has_table_privilege(
            'battle_bus_runtime', 'public.fulfillment_action_tombstones', 'SELECT'
          )
          AND has_table_privilege(
            current_user, 'public.fulfillment_action_tombstones', 'SELECT'
          )
          AND has_table_privilege(
            current_user, 'public.fulfillment_housekeeping_run_receipts', 'SELECT'
          )
          AND NOT has_table_privilege(
            current_user, 'public.fulfillment_actions', 'DELETE'
          )
          AND NOT has_table_privilege(
            current_user, 'public.fulfillment_action_aliases', 'DELETE'
          )
          AND NOT has_table_privilege(
            current_user, 'public.fulfillment_evidence_claims', 'DELETE'
          )
          AND NOT has_table_privilege(
            current_user,
            'public.fulfillment_action_tombstones',
            'INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            current_user,
            'public.fulfillment_housekeeping_successor',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            current_user,
            'public.fulfillment_action_housekeeping_quarantine',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            current_user,
            'public.fulfillment_housekeeping_run_receipts',
            'INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'anon',
            'public.fulfillment_action_tombstones',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'authenticated',
            'public.fulfillment_action_tombstones',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'anon',
            'public.fulfillment_housekeeping_successor',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'authenticated',
            'public.fulfillment_housekeeping_successor',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'anon',
            'public.fulfillment_action_housekeeping_quarantine',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'authenticated',
            'public.fulfillment_action_housekeeping_quarantine',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'anon',
            'public.fulfillment_housekeeping_run_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_table_privilege(
            'authenticated',
            'public.fulfillment_housekeeping_run_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT has_function_privilege(
            'anon',
            'public.delete_retained_fulfillment_actions(integer,integer)',
            'EXECUTE'
          )
          AND NOT has_function_privilege(
            'authenticated',
            'public.delete_retained_fulfillment_actions(integer,integer)',
            'EXECUTE'
          )
          AND NOT has_function_privilege(
            'anon',
            'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)',
            'EXECUTE'
          )
          AND NOT has_function_privilege(
            'authenticated',
            'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)',
            'EXECUTE'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
              'public.delete_retained_fulfillment_actions(integer,integer)',
              'public.claim_fulfillment_housekeeping_successor(text,integer,integer,integer)',
              'public.authorize_fulfillment_housekeeping_successor(uuid)',
              'public.consume_fulfillment_housekeeping_successor(uuid)',
              'public.record_fulfillment_housekeeping_run_receipt(text,integer,integer,integer,integer,integer,integer,boolean,uuid,text,integer)'
            ]) AS secured(signature)
            WHERE has_function_privilege('anon', secured.signature, 'EXECUTE')
              OR has_function_privilege('authenticated', secured.signature, 'EXECUTE')
          )
          AS ready`);
        fulfillmentActionLedgerSchema = result.rows[0]?.ready === true;
      }
    }
  } catch {
    /* Never expose database credentials or connection errors. */
  }
  const dependencies: Record<string, { ready: boolean; check: string }> = {
    cloudSql: { ready: database, check: "connectivity" },
    shopify: {
      ready: Boolean(config.shopify.im8.shopDomain && config.shopify.im8.accessToken),
      check: "configuration",
    },
    inngest: {
      ready: Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY),
      check: "configuration",
    },
    battleHub: {
      ready:
        config.csPlatform.enabled &&
        Boolean(config.csPlatform.baseUrl && config.csPlatform.webhookSecret) &&
        (!process.env.K_SERVICE ||
          (process.env.BATTLE_HUB_IAP_ENABLED === "true" &&
            Boolean(process.env.BATTLE_HUB_CALLER_SERVICE_ACCOUNT))),
      check: "configuration",
    },
  };
  if (channelLiftEnabled) {
    dependencies.channelLift = { ready: channelLiftSchema, check: "schema-and-privileges" };
  }
  dependencies.fulfillmentActionLedger = {
    ready: fulfillmentActionLedgerSchema,
    check: "schema-and-privileges",
  };
  if (fulfillmentHousekeepingEnabled) {
    dependencies.fulfillmentActionHousekeeping = {
      ready: fulfillmentActionLedgerSchema,
      check: "schema-and-privileges",
    };
  }
  return {
    ok: Object.values(dependencies).every((dependency) => dependency.ready),
    service: "battle-bus",
    dependencies,
    dryRun: config.features.dryRunMode,
  };
}

export type ReadinessDependency = {
  name: string;
  required: boolean;
  status: "ready" | "unavailable" | "disabled";
  check: "configuration" | "connectivity" | "schema-and-privileges";
};
/**
 * Compatibility report for the stricter cutover gate. Provider credentials are
 * only configuration signals here; dependency-health upgrades them to an
 * authenticated read before it can certify a cutover.
 */
export async function getReadinessReport(): Promise<{
  ok: boolean;
  dependencies: ReadinessDependency[];
}> {
  const basic = await checkReadiness();
  const configured = (name: keyof typeof basic.dependencies) => basic.dependencies[name].ready;
  const dependency = (
    name: string,
    required: boolean,
    ready: boolean,
    check: ReadinessDependency["check"]
  ): ReadinessDependency => ({
    name,
    required,
    status: !required ? "disabled" : ready ? "ready" : "unavailable",
    check,
  });

  const dependencies: ReadinessDependency[] = [
    dependency("cloudSql", true, configured("cloudSql"), "connectivity"),
    dependency(
      "fulfillmentActionLedger",
      true,
      configured("fulfillmentActionLedger"),
      "schema-and-privileges"
    ),
    dependency(
      "channelLift",
      config.channelLift.enabled,
      basic.dependencies.channelLift?.ready === true,
      "configuration"
    ),
    dependency("shopify", true, configured("shopify"), "configuration"),
    dependency("inngest", true, configured("inngest"), "configuration"),
    dependency("battleHub", config.csPlatform.enabled, configured("battleHub"), "configuration"),
    dependency(
      "dynamics",
      config.features.enableDynamicsSync || config.reconciliation.directD365Enabled,
      Boolean(
        config.dynamics.baseUrl &&
        config.dynamics.tenantId &&
        config.dynamics.clientId &&
        config.dynamics.clientSecret
      ),
      "configuration"
    ),
    dependency(
      "gps_us",
      config.features.enableGpsSync,
      !config.features.dryRunMode,
      "configuration"
    ),
    dependency(
      "gps_uk",
      config.features.enableGpsSync,
      !config.features.dryRunMode,
      "configuration"
    ),
  ];
  return {
    ok: basic.ok && dependencies.every((item) => !item.required || item.status === "ready"),
    dependencies,
  };
}
