// ============================================================================
// GPS FULFILMENT RECOVERY (Hub → Battle Bus)
// ============================================================================
// Queues gps/recover.fulfilment for one Shopify order name.

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { requireServiceAuth } from "@/lib/auth/service-auth";

function normalizeOrderName(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#/, "");
}

export async function POST(request: NextRequest) {
  try {
    const auth = requireServiceAuth(request, {
      envVars: ["EVENT_SEND_SECRET", "CS_PLATFORM_WEBHOOK_SECRET", "BATTLE_BUS_API_KEY"],
    });
    if (!auth.ok) {
      return NextResponse.json(auth.body, { status: auth.status });
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
