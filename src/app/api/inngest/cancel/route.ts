import { NextRequest, NextResponse } from "next/server";

const INNGEST_API_URL = "https://api.inngest.com";
const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY || "";
const INNGEST_APP_ID = process.env.INNGEST_APP_ID || "";

export async function POST(request: NextRequest) {
  try {
    if (!INNGEST_SIGNING_KEY) {
      return NextResponse.json({ error: "INNGEST_SIGNING_KEY not configured" }, { status: 500 });
    }

    const body = await request.json();
    const { runIds, functionId } = body as {
      runIds?: string[];
      functionId?: string;
    };

    if (!runIds || runIds.length === 0) {
      return NextResponse.json({ error: "runIds[] is required" }, { status: 400 });
    }

    let cancelled = 0;
    const errors: string[] = [];

    // Inngest doesn't have a bulk cancel by runId — cancel each individually
    await Promise.allSettled(
      runIds.map(async (runId) => {
        try {
          const res = await fetch(`${INNGEST_API_URL}/v1/runs/${runId}/cancel`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
              "Content-Type": "application/json",
            },
          });
          if (res.ok || res.status === 409) {
            // 409 = already completed/cancelled — still counts
            cancelled++;
          } else {
            const text = await res.text();
            errors.push(`${runId}: ${res.status} ${text}`);
          }
        } catch (err) {
          errors.push(`${runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );

    return NextResponse.json({
      cancelled,
      total: runIds.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("[Inngest Cancel] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
