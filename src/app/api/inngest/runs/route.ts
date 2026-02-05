// ============================================================================
// INNGEST RUNS API (Battle Bus)
// ============================================================================
// Fetches run status and details from Inngest API for monitoring in Battle Hub

import { NextRequest, NextResponse } from "next/server";

const INNGEST_API_URL = "https://api.inngest.com";
const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY || "";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");
    const eventId = searchParams.get("eventId");
    const orderName = searchParams.get("orderName");
    const limit = searchParams.get("limit") || "10";

    if (!INNGEST_SIGNING_KEY) {
      return NextResponse.json(
        { error: "INNGEST_SIGNING_KEY not configured" },
        { status: 500 }
      );
    }

    // If runId provided, fetch specific run details
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
        return NextResponse.json(
          { error: `Failed to fetch run: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      return NextResponse.json(data);
    }

    // If eventId provided, fetch runs for that event
    if (eventId) {
      const response = await fetch(
        `${INNGEST_API_URL}/v1/events/${eventId}/runs?limit=${limit}`,
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
        return NextResponse.json(
          { error: `Failed to fetch runs: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      return NextResponse.json(data);
    }

    // If orderName provided, search for runs with that order
    if (orderName) {
      // Search runs by filtering - this searches recent runs
      const response = await fetch(
        `${INNGEST_API_URL}/v1/runs?limit=${limit}`,
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
        return NextResponse.json(
          { error: `Failed to fetch runs: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      
      // Filter runs that contain the orderName in their event data
      // Note: This is a client-side filter since Inngest API doesn't support deep filtering
      const filteredRuns = data.data?.filter((run: any) => {
        const eventData = run.event?.data || {};
        return (
          eventData.orderName === orderName ||
          eventData.shopifyOrderName === orderName ||
          run.event?.name?.includes(orderName)
        );
      });

      return NextResponse.json({
        ...data,
        data: filteredRuns || [],
      });
    }

    // Default: fetch recent runs
    const response = await fetch(`${INNGEST_API_URL}/v1/runs?limit=${limit}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `Failed to fetch runs: ${error}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
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
