// ============================================================================
// INNGEST RUNS API (Battle Bus)
// ============================================================================
// Fetches run status and details from Inngest API for monitoring in Battle Hub
// 
// Response format includes:
// - run_id (or id): The unique run identifier for /runs/ URLs
// - event_id: The internal event ID for /events/ URLs (NOT the idempotency key)
//
// NOTE: The idempotency key (e.g., "shopify-order-paid-xxx") is NOT the same as
// the internal event_id (e.g., "01KGWYGF2KP7NBD9F7M2A51J65")

import { NextRequest, NextResponse } from "next/server";

const INNGEST_API_URL = "https://api.inngest.com";
const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY || "";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");
    const eventId = searchParams.get("eventId");

    if (!INNGEST_SIGNING_KEY) {
      return NextResponse.json(
        { error: "INNGEST_SIGNING_KEY not configured" },
        { status: 500 }
      );
    }

    // If eventId provided, fetch runs for that event
    // NOTE: eventId must be the INTERNAL event ID (e.g., "01KGWYGF2KP7NBD9F7M2A51J65")
    // NOT the idempotency key (e.g., "shopify-order-paid-xxx")
    if (eventId) {
      const response = await fetch(
        `${INNGEST_API_URL}/v1/events/${eventId}/runs`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Inngest Runs] Failed to fetch runs for event ${eventId}:`, error);
        return NextResponse.json(
          { error: `Failed to fetch runs: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      return NextResponse.json({ data: data.data || data });
    }

    // If runId provided, fetch specific run details
    // The response includes event_id which is the internal event ID for /events/ URLs
    if (runId) {
      const response = await fetch(`${INNGEST_API_URL}/v1/runs/${runId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Inngest Runs] Failed to fetch run ${runId}:`, error);
        return NextResponse.json(
          { error: `Failed to fetch run: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      // Normalize the response - ensure both id/run_id and event_id are present
      const normalizedRun = {
        ...data,
        id: data.id || data.run_id,
        run_id: data.run_id || data.id,
        event_id: data.event_id,
      };
      return NextResponse.json({ data: [normalizedRun] });
    }

    // No eventId or runId - return empty array with explanation
    // The Inngest REST API doesn't support listing all runs without an eventId
    return NextResponse.json({
      data: [],
      message: "eventId or runId required - Inngest API doesn't support listing all runs",
    });
  } catch (error) {
    console.error("[Inngest Runs] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
