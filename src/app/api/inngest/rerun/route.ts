// ============================================================================
// INNGEST RERUN API (Battle Bus)
// ============================================================================
// Allows battle-hub to trigger event reruns via the Inngest client
// This endpoint uses the configured Inngest client to send events

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { runId, eventId, functionId, eventName, eventData, orderName } = body;

    // If orderName is provided, trigger an order reprocess event
    if (orderName) {
      const eventPayload = {
        name: eventName || "order/reprocess",
        data: {
          orderName,
          reprocessedAt: new Date().toISOString(),
          source: "battle-hub",
          ...eventData,
        },
      };

      // Send the event using the Inngest client
      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Reprocess event sent for order ${orderName}`,
        eventId: result.ids?.[0],
      });
    }

    // If eventId is provided, send a support/rerun event
    if (eventId) {
      const eventPayload = {
        name: eventName || "support/rerun",
        data: {
          eventId,
          rerunAt: new Date().toISOString(),
          source: "battle-hub",
          ...eventData,
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Rerun event sent for eventId ${eventId}`,
        eventId: result.ids?.[0],
      });
    }

    // If runId is provided, we need to use the Inngest API directly
    // This requires the signing key for authentication
    if (runId) {
      const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY;
      
      if (!INNGEST_SIGNING_KEY) {
        return NextResponse.json(
          { error: "INNGEST_SIGNING_KEY not configured" },
          { status: 500 }
        );
      }

      const response = await fetch(
        `https://api.inngest.com/v1/runs/${runId}/rerun`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(functionId && { function_id: functionId }),
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return NextResponse.json(
          { error: `Inngest API error: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json(
      { error: "Either runId, eventId, or orderName is required" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Inngest Rerun] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
