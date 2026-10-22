import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

/** A read-only DB round trip plus configuration checks, not provider write tests. */
export async function checkReadiness() {
  let database = false;
  try {
    if (isDatabaseConfigured()) {
      await queryDatabase("SELECT 1 AS ready");
      database = true;
    }
  } catch { /* Never expose database credentials or connection errors. */ }
  const dependencies = {
    cloudSql: { ready: database, check: "connectivity" },
    shopify: { ready: Boolean(config.shopify.im8.shopDomain && config.shopify.im8.accessToken), check: "configuration" },
    inngest: { ready: Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY), check: "configuration" },
    battleHub: { ready: config.csPlatform.enabled && Boolean(config.csPlatform.baseUrl && config.csPlatform.webhookSecret) &&
      (!process.env.K_SERVICE || (process.env.BATTLE_HUB_IAP_ENABLED === "true" && Boolean(process.env.BATTLE_HUB_CALLER_SERVICE_ACCOUNT))), check: "configuration" },
  };
  return {
    ok: Object.values(dependencies).every(dependency => dependency.ready),
    service: "battle-bus", dependencies, dryRun: config.features.dryRunMode,
  };
}
