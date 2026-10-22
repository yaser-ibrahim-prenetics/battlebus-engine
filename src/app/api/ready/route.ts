import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/services/readiness";

export const dynamic = "force-dynamic";

/** Minimal public deployment signal; detailed dependencies remain authenticated. */
export async function GET() {
  const { ok } = await checkReadiness();
  return NextResponse.json({ ok }, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
