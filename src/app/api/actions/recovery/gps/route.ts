// ============================================================================
// GPS FULFILMENT RECOVERY (Hub → Battle Bus)
// ============================================================================
// Queues gps/recover.fulfilment for one Shopify order name.

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

const EVENT_SEND_SECRET =
  process.env.EVENT_SEND_SECRET || process.env.CS_PLATFORM_WEBHOOK_SECRET || "";

function normalizeOrderName(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#/, "");
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!EVENT_SEND_SECRET || token !== EVENT_SEND_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const shopifyOrderName = normalizeOrderName(
      body.shopifyOrderName ?? body.shopify_order_name
    );
    if (!shopifyOrderName) {
      return NextResponse.json(
        { error: "shopifyOrderName is required" },
        { status: 400 }
      );
    }

    const source =
      typeof body.source === "string" && body.source.trim()
        ? body.source.trim()
        : "hub_recovery";

    const eventId = `gps-recover-${shopifyOrderName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const result = await inngest.send({
      id: eventId,
      name: "gps/recover.fulfilment",
      data: {
        shopifyOrderName,
        source,
        requestedAt: new Date().toISOString(),
        triggeredByUserId: body.triggeredByUserId,
        triggeredByUserEmail: body.triggeredByUserEmail,
      },
    });

    return NextResponse.json({
      success: true,
      shopifyOrderName,
      ids: result.ids ?? [],
    });
  } catch (error) {
    console.error("[recovery/gps] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to queue GPS recovery",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
