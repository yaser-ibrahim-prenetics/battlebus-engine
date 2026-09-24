// ============================================================================
// SHOPIFY ORDER DETAILS API (Battle Bus)
// ============================================================================
// Returns full Shopify order details (including line items) and GPS metafield
// for use by battle-cs when opening an order.
//
// Input:
//   POST { orderName: string, shopDomain?: string }   // order name (e.g. "#1234") or numeric ID;
//   shopDomain: optional *.myshopify.com host so PROD vs TEST Admin token matches the store

import { NextRequest, NextResponse } from "next/server";
import * as shopify from "@/lib/clients/shopify";
import { requireServiceAuth } from "@/lib/auth/service-auth";

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  try {
    const body = await request.json();
    const { orderName, orderId, shopDomain } = body ?? {};

    // Support both orderName and orderId for backward compatibility
    const identifier = orderName || orderId;

    if (!identifier) {
      return NextResponse.json({ error: "orderName or orderId is required" }, { status: 400 });
    }

    const shopDomainHint =
      typeof shopDomain === "string" && shopDomain.trim() ? shopDomain.trim() : undefined;

    // Try to parse as numeric ID first
    const numericId = Number(identifier);
    let order: any;
    let actualOrderId: number;

    if (Number.isFinite(numericId)) {
      // It's a numeric ID, use getOrder directly
      order = await shopify.getOrder(numericId, shopDomainHint);
      actualOrderId = numericId;
    } else {
      // It's an order name (e.g., "#1234"), search by name
      const orders = await shopify.searchOrdersByName(identifier, shopDomainHint);
      if (!orders || orders.length === 0) {
        return NextResponse.json({ error: `Order ${identifier} not found` }, { status: 404 });
      }
      order = orders[0];
      actualOrderId = order.id;
    }

    let gpsMetafield: unknown = null;
    try {
      gpsMetafield = await shopify.getGpsOrderMetafield(actualOrderId, shopDomainHint);
    } catch (err) {
      console.warn("[Shopify Order Details] Failed to load GPS metafield:", err);
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
