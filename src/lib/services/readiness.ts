import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

/** A read-only DB round trip plus configuration checks, not provider write tests. */
export async function checkReadiness() {
  let database = false;
  const channelLiftEnabled = config.channelLift?.enabled === true;
  let channelLiftSchema = !channelLiftEnabled;
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
                  'FOREIGN KEY (run_id, request_id, mode, source) REFERENCES channel_lift_runs(run_id, request_id, mode, source)%'
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
  return {
    ok: Object.values(dependencies).every((dependency) => dependency.ready),
    service: "battle-bus",
    dependencies,
    dryRun: config.features.dryRunMode,
  };
}
