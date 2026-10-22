import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { config } from "@/lib/config";
import { isDatabaseConfigured, queryDatabase } from "@/lib/db/database";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  let database = false;
  try {
    if (isDatabaseConfigured()) { await queryDatabase("SELECT 1 AS ready"); database = true; }
  } catch { /* Report the dependency without leaking connection credentials. */ }
  const dependencies = {
    cloudSql: { ready: database, check: "connectivity" },
    shopify: { ready: Boolean(config.shopify.im8.shopDomain && config.shopify.im8.accessToken), check: "configuration" },
    inngest: { ready: Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY), check: "configuration" },
    battleHub: { ready: config.csPlatform.enabled && Boolean(config.csPlatform.baseUrl && config.csPlatform.webhookSecret) &&
      (!process.env.K_SERVICE || (process.env.BATTLE_HUB_IAP_ENABLED === "true" && Boolean(process.env.BATTLE_HUB_CALLER_SERVICE_ACCOUNT))), check: "configuration" },
  };
  const ok = Object.values(dependencies).every(dependency => dependency.ready);
  return NextResponse.json({ ok, service: "battle-bus", dependencies, dryRun: config.features.dryRunMode }, { status: ok ? 200 : 503 });
}
