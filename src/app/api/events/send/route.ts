// ============================================================================
// SEND EVENT TO INNGEST
// ============================================================================
// API endpoint to receive events from external services (like Battle Hub)
// and forward them to Inngest via the SDK.
//
// This is needed because:
// - The /api/inngest endpoint is for Inngest to invoke functions, not receive events
// - External services don't have the Inngest event key
// - This provides a controlled ingestion point

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

const EVENT_SEND_SECRET =
  process.env.EVENT_SEND_SECRET || process.env.CS_PLATFORM_WEBHOOK_SECRET || "";

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!EVENT_SEND_SECRET || token !== EVENT_SEND_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, data, id: clientEventId } = body as {
      name?: string;
      data?: unknown;
      id?: string;
    };

    if (!name) {
      return NextResponse.json({ error: "Event name is required" }, { status: 400 });
    }

    console.log(
      JSON.stringify({
        tag: "battle-bus.events.send",
        at: new Date().toISOString(),
        phase: "receive",
        eventName: name,
        dataKeys:
          data && typeof data === "object" ? Object.keys(data as object) : [],
        dataPreview:
          name === "reconciliation/run" && data && typeof data === "object"
            ? {
                type: (data as Record<string, unknown>).type,
                dateFrom: (data as Record<string, unknown>).dateFrom,
                dateTo: (data as Record<string, unknown>).dateTo,
              }
            : undefined,
      })
    );

    // Send the event to Inngest (optional id allows safe replays per order)
    const result = await inngest.send(
      clientEventId && String(clientEventId).trim()
        ? { id: String(clientEventId).trim(), name, data: data || {} }
        : { name, data: data || {} }
    );

    console.log(
      JSON.stringify({
        tag: "battle-bus.events.send",
        at: new Date().toISOString(),
        phase: "sent",
        eventName: name,
        inngestIds: result.ids ?? [],
      })
    );

    return NextResponse.json({
      success: true,
      message: `Event ${name} sent to Inngest`,
      ids: result.ids,
    });
  } catch (error) {
    console.error("[send-event] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to send event",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
