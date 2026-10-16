import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { listDeadLetters } from "@/lib/services/webhook-inbox";

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 100);
  const limit = Number.isInteger(requestedLimit) ? requestedLimit : 100;
  try {
    return NextResponse.json({ deadLetters: await listDeadLetters(limit) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "dead_letters_unavailable", message }, { status: 503 });
  }
}
