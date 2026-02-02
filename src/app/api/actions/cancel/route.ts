// ============================================================================
// ORDER CANCELLATION ACTION API (Battle Bus)
// ============================================================================
// Cancels a Shopify order using Battle Bus Shopify configuration.
// Intended to be called from battle-cs; downstream systems are updated
// via Shopify webhooks and Inngest functions.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderId, reason, email, refund } = body ?? {};

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const shopDomain = config.shopify.im8.shopDomain;
    const accessToken = config.shopify.im8.accessToken;
    const apiVersion = config.shopify.im8.apiVersion;

    if (!shopDomain || !accessToken) {
      return NextResponse.json(
        { error: "Shopify configuration missing in Battle Bus" },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/orders/${orderId}/cancel.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          reason: reason || "other",
          email: email !== false,
          refund: refund || false,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Failed to cancel order in Shopify",
          details: result,
        },
        { status: response.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Order cancelled via Battle Bus",
        data: result.order,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Actions] Error cancelling order:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


