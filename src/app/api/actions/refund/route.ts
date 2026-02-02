// ============================================================================
// ORDER REFUND ACTION API (Battle Bus)
// ============================================================================
// Creates a Shopify refund (full, partial amount, or per-line) using Battle Bus
// Shopify configuration. Called from battle-cs; downstream D365 credit note,
// etc. are handled by Battle Bus via Shopify webhooks and Inngest.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderId, amount, reason, note, refundLineItems, restock, notify } =
      body ?? {};

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

    const refund: any = {
      note: note || reason || "Refund processed by support",
      notify: notify !== false,
      ...(restock !== undefined && { restock }),
    };

    if (Array.isArray(refundLineItems) && refundLineItems.length > 0) {
      refund.refund_line_items = refundLineItems.map((item: any) => ({
        line_item_id: item.lineItemId,
        quantity: item.quantity,
        restock_type: item.restockType || "cancel",
      }));
    } else if (amount) {
      refund.amount = String(amount);
    } else {
      refund.full_refund = true;
    }

    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/orders/${orderId}/refunds.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ refund }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Failed to create refund in Shopify",
          details: result,
        },
        { status: response.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Refund created via Battle Bus",
        data: result.refund,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Actions] Error creating refund:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


