import { NextRequest, NextResponse } from "next/server";
import { getLocationCacheStatus, refreshLocationMappings } from "@/lib/services/location-routing";

const CONFIG_ENV_PROXY_SECRET = process.env.CONFIG_ENV_PROXY_SECRET || "";

function isProxyAuthorized(request: NextRequest): boolean {
  if (!CONFIG_ENV_PROXY_SECRET) return true;
  const received = request.headers.get("x-config-env-proxy-secret") || "";
  return received === CONFIG_ENV_PROXY_SECRET;
}

export async function GET(request: NextRequest) {
  if (!isProxyAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized proxy request" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    cache: getLocationCacheStatus(),
    scope: "location-routing",
  });
}

export async function POST(request: NextRequest) {
  if (!isProxyAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized proxy request" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const reason =
    body && typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : "manual_push";

  const refreshed = await refreshLocationMappings(reason);
  return NextResponse.json({
    ok: true,
    refreshedAt: new Date().toISOString(),
    ...refreshed,
    cache: getLocationCacheStatus(),
  });
}
