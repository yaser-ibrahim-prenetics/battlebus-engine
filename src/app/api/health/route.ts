import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "battle-bus",
    revision: process.env.K_REVISION || null,
    timestamp: new Date().toISOString(),
  });
}
