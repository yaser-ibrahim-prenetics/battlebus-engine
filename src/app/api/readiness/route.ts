import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { checkReadiness } from "@/lib/services/readiness";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const report = await checkReadiness();
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
