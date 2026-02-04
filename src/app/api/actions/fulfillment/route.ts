// ============================================================================
// ORDER FULFILLMENT ACTION API (Battle Bus)
// ============================================================================
// Creates a Shopify fulfillment using existing Shopify client utilities.
// Intended to be called from battle-cs instead of talking to Shopify directly.
//
// Flow:
//   battle-cs → /api/actions/fulfillment → Shopify
//   → Shopify webhooks → Inngest functions (D365, GPS, etc.)
//
// This keeps Battle Bus as the integration mesh while allowing CS to trigger
// operational actions.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      orderId,
      orderName,
      fulfillmentOrderId,
      trackingNumber,
      carrier,
      locationId,
      lineItems,
      notifyCustomer,
    } = body ?? {};

    // Support both orderName and orderId for backward compatibility
    const identifier = orderName || orderId;

    if (!identifier || !fulfillmentOrderId) {
      return NextResponse.json(
        { error: "orderName (or orderId) and fulfillmentOrderId are required" },
        { status: 400 }
      );
    }

    // Resolve order name to numeric ID if needed (for GPS metafield lookup)
    let numericOrderId: number | undefined;
    const numericId = Number(identifier);
    
    if (Number.isFinite(numericId)) {
      numericOrderId = numericId;
    } else {
      // It's an order name, search for it to get the ID
      const orders = await shopify.searchOrdersByName(identifier);
      if (!orders || orders.length === 0) {
        return NextResponse.json(
          { error: `Order ${identifier} not found` },
          { status: 404 }
        );
      }
      numericOrderId = orders[0].id;
    }

    if (!trackingNumber) {
      return NextResponse.json(
        { error: "trackingNumber is required" },
        { status: 400 }
      );
    }

    // Build tracking info compatible with Shopify client
    const trackingInfo = {
      number: trackingNumber as string,
      company: carrier || "Other",
      url: getTrackingUrl(carrier || "", trackingNumber as string),
    };

    // If lineItems provided, map to expected shape for createFulfillment
    const fulfillmentLineItems =
      Array.isArray(lineItems) && lineItems.length > 0
        ? lineItems.map((item: any) => ({
            id: item.id,
            quantity: item.quantity,
          }))
        : undefined;

    const fulfillment = await shopify.createFulfillment(
      Number(fulfillmentOrderId),
      trackingInfo,
      fulfillmentLineItems
    );

    // Note: Inngest + webhooks will take care of syncing to D365, GPS, etc.

    return NextResponse.json(
      {
        success: true,
        message: "Fulfillment created via Battle Bus",
        data: fulfillment,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Actions] Error creating fulfillment:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

function getTrackingUrl(carrier: string, trackingNumber: string): string {
  const carrierLower = carrier.toLowerCase();
  if (carrierLower.includes("fedex")) {
    return `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
  }
  if (carrierLower.includes("ups")) {
    return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  }
  if (carrierLower.includes("usps")) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  }
  if (carrierLower.includes("dhl")) {
    return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  }
  if (carrierLower.includes("sf")) {
    return `https://www.sf-express.com/en/dynamic_function/waybill/#search/bill-number/${trackingNumber}`;
  }
  return `https://track.aftership.com/${trackingNumber}`;
}


