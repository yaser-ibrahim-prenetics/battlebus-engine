import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

export type ReadinessDependency = {
  name: string;
  required: boolean;
  status: "ready" | "disabled" | "not_configured" | "unavailable";
  check: "connectivity" | "configuration";
  latencyMs?: number;
};

export type ReadinessReport = {
  ok: boolean;
  service: "battle-bus";
  revision: string | null;
  checkedAt: string;
  dependencies: ReadinessDependency[];
};

function configured(
  name: string,
  required: boolean,
  values: Array<string | undefined>
): ReadinessDependency {
  if (!required) return { name, required, status: "disabled", check: "configuration" };
  return {
    name,
    required,
    status: values.every((value) => Boolean(value?.trim())) ? "ready" : "not_configured",
    check: "configuration",
  };
}

async function databaseReadiness(): Promise<ReadinessDependency> {
  const startedAt = Date.now();
  if (!isDatabaseConfigured()) {
    return { name: "cloud_sql", required: true, status: "not_configured", check: "connectivity" };
  }
  try {
    await queryDatabase("SELECT 1 AS ready");
    return {
      name: "cloud_sql",
      required: true,
      status: "ready",
      check: "connectivity",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.error("[Readiness] Cloud SQL probe failed", error);
    return {
      name: "cloud_sql",
      required: true,
      status: "unavailable",
      check: "connectivity",
      latencyMs: Date.now() - startedAt,
    };
  }
}

export async function getReadinessReport(): Promise<ReadinessReport> {
  const dependencies = [
    await databaseReadiness(),
    configured("shopify", true, [config.shopify.im8.shopDomain, config.shopify.im8.accessToken]),
    configured("dynamics", config.features.enableDynamicsSync, [
      config.dynamics.baseUrl,
      config.dynamics.tenantId,
      config.dynamics.clientId,
      config.dynamics.clientSecret,
    ]),
    configured("gps_us", config.features.enableGpsSync, [
      config.gps.baseUrl,
      config.gps.apiKey,
      config.gps.apiSecret,
    ]),
    configured("gps_uk", config.features.enableGpsSync, [
      config.gpsUk.baseUrl,
      config.gpsUk.apiKey,
      config.gpsUk.apiSecret,
    ]),
    configured("battle_hub", config.csPlatform.enabled, [
      config.csPlatform.baseUrl || process.env.BATTLE_HUB_URL,
    ]),
    configured("inngest", Boolean(process.env.K_SERVICE), [
      process.env.INNGEST_EVENT_KEY,
      process.env.INNGEST_SIGNING_KEY,
    ]),
  ];

  return {
    ok: dependencies.every(
      (dependency) => !dependency.required || dependency.status === "ready"
    ),
    service: "battle-bus",
    revision: process.env.K_REVISION || null,
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}
