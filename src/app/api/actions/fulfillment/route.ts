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
      fulfillmentOrderId,
      trackingNumber,
      carrier,
      locationId,
      lineItems,
      notifyCustomer,
    } = body ?? {};

    if (!orderId || !fulfillmentOrderId) {
      return NextResponse.json(
        { error: "orderId and fulfillmentOrderId are required" },
        { status: 400 }
      );
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


