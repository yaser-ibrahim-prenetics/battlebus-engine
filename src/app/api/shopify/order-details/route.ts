// ============================================================================
// SHOPIFY ORDER DETAILS API (Battle Bus)
// ============================================================================
// Returns full Shopify order details (including line items) and GPS metafield
// for use by battle-cs when opening an order.
//
// Input:
//   POST { orderId: string }   // Shopify numeric order ID

import { NextRequest, NextResponse } from "next/server";
import * as shopify from "@/lib/clients/shopify";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderId } = body ?? {};

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const numericId = Number(orderId);
    if (!Number.isFinite(numericId)) {
      return NextResponse.json(
        { error: "orderId must be a numeric Shopify order ID" },
        { status: 400 }
      );
    }

    const order = await shopify.getOrder(numericId);

    let gpsMetafield: unknown = null;
    try {
      gpsMetafield = await shopify.getGpsOrderMetafield(numericId);
    } catch (err) {
      console.warn(
        "[Shopify Order Details] Failed to load GPS metafield:",
        err
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          order,
          gpsMetafield,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Shopify Order Details] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


