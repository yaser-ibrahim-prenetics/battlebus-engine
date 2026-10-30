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
          AND to_regprocedure('public.battle_platform_enforce_channel_lift_transition()') IS NOT NULL
          AND has_table_privilege(current_user, 'public.channel_lift_runs', 'SELECT,INSERT')
          AND has_column_privilege(current_user, 'public.channel_lift_runs', 'status', 'UPDATE')
          AS ready`);
        channelLiftSchema = result.rows[0]?.ready === true;
      }
    }
  } catch { /* Never expose database credentials or connection errors. */ }
  const dependencies: Record<string, { ready: boolean; check: string }> = {
    cloudSql: { ready: database, check: "connectivity" },
    shopify: { ready: Boolean(config.shopify.im8.shopDomain && config.shopify.im8.accessToken), check: "configuration" },
    inngest: { ready: Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY), check: "configuration" },
    battleHub: { ready: config.csPlatform.enabled && Boolean(config.csPlatform.baseUrl && config.csPlatform.webhookSecret) &&
      (!process.env.K_SERVICE || (process.env.BATTLE_HUB_IAP_ENABLED === "true" && Boolean(process.env.BATTLE_HUB_CALLER_SERVICE_ACCOUNT))), check: "configuration" },
  };
  if (channelLiftEnabled) {
    dependencies.channelLift = { ready: channelLiftSchema, check: "schema-and-privileges" };
  }
  return {
    ok: Object.values(dependencies).every(dependency => dependency.ready),
    service: "battle-bus", dependencies, dryRun: config.features.dryRunMode,
  };
}
