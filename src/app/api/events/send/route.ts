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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, data } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Event name is required" },
        { status: 400 }
      );
    }

    console.log(`[send-event] Receiving event: ${name}`);
    console.log(`[send-event] Data:`, JSON.stringify(data, null, 2));

    // Send the event to Inngest
    const result = await inngest.send({
      name,
      data: data || {},
    });

    console.log(`[send-event] Event sent successfully:`, result);

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
