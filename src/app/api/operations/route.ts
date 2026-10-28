import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { queryDatabase } from "@/lib/db/database";
import { deepReadiness } from "@/lib/services/operations/health";
import { recentAttemptsSQL } from "@/lib/sql/reconciliation-history/attempts";
import { inboxSummariesSQL, actionSummariesSQL } from "@/lib/sql/operations/health";
import { recentCommandsSQL } from "@/lib/sql/operations/commands";
import { reserveRecoveryRequest } from "@/lib/services/operations/commands";
import { inngest } from "@/inngest/client";
import { ZodError } from "zod";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const view = request.nextUrl.searchParams.get("view") ?? "history";
  try {
    if (view === "health")
      return NextResponse.json(await deepReadiness(), { headers: { "Cache-Control": "no-store" } });
    const queries = {
      history: recentAttemptsSQL,
      inbox: inboxSummariesSQL,
      actions: actionSummariesSQL,
      commands: recentCommandsSQL,
    };
    if (!(view in queries))
      return NextResponse.json({ error: "Unknown operations view" }, { status: 400 });
    const result = await queryDatabase(
      queries[view as keyof typeof queries],
      view === "history" ? [50] : []
    );
    return NextResponse.json({ rows: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Operational evidence unavailable" }, { status: 503 });
  }
}
export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  try {
    const saved = await reserveRecoveryRequest(await request.json());
    // The durable queued command is also picked up by the cron if publishing fails.
    if (saved.status === "queued") {
      try {
        await inngest.send({
          id: `admin-recovery:${saved.requestId}`,
          name: "operations/recovery.requested",
          data: { requestId: saved.requestId },
        });
      } catch {
        console.error("[Recovery] Command queued; event delivery deferred to cron");
      }
    }
    return NextResponse.json(saved, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "Recovery request rejected; check parameters or reuse the original request unchanged",
      },
      { status: error instanceof ZodError ? 400 : 409 }
    );
  }
}
