import { NextRequest, NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { queueSlackTest } from "@/lib/services/slack-notifications/test-notification";

export const dynamic = "force-dynamic";

/** Hub enforces human roles; this boundary requires the server-only service credential. */
export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  try {
    // Never accept arbitrary message text, channel, webhook, or notification IDs.
    const result = await queueSlackTest();
    if (!result.enabled) {
      return NextResponse.json(
        { error: "Slack Pub/Sub publishing is disabled or unavailable" },
        { status: 503 }
      );
    }
    return NextResponse.json(result, { status: result.status === "failed" ? 503 : 202 });
  } catch {
    return NextResponse.json(
      {
        error: "Unable to confirm the Slack test. Retry within this minute to reuse the same test.",
      },
      { status: 503 }
    );
  }
}
