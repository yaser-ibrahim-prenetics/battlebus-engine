import { NextRequest, NextResponse } from "next/server";
import { getLocationCacheStatus, refreshLocationMappings } from "@/lib/services/location-routing";
import { requireServiceAuth } from "@/lib/auth/service-auth";

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request, { envVars: ["CONFIG_ENV_PROXY_SECRET"] });
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  return NextResponse.json({
    ok: true,
    cache: getLocationCacheStatus(),
    scope: "location-routing",
  });
}

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request, { envVars: ["CONFIG_ENV_PROXY_SECRET"] });
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
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
