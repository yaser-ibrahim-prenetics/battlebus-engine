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
      fulfillmentType,
      trackingNumber,
      carrier,
      locationId,
      lineItems,
      notifyCustomer,
      platform,
    } = body ?? {};

    // Support both orderName and orderId for backward compatibility
    // If platform is 'shopify', try orderId first, then fallback to orderName
    let numericOrderId: number | undefined;
    let resolvedFulfillmentOrderId: number | undefined = fulfillmentOrderId ? Number(fulfillmentOrderId) : undefined;

    // Try to resolve order ID with fallback logic (same as cancel/refund)
    if (orderId) {
      const numericId = Number(orderId);
      if (Number.isFinite(numericId) && !isNaN(numericId)) {
        // It's a valid numeric ID, try to use it
        numericOrderId = numericId;
      } else if (platform === 'shopify' && orderName) {
        // orderId is not numeric (e.g., "shopify-12346"), try orderName instead
        const orders = await shopify.searchOrdersByName(orderName);
        if (orders && orders.length > 0) {
          numericOrderId = orders[0].id;
        }
      }
    }

    // If we still don't have a numeric ID, try orderName
    if (!numericOrderId && orderName) {
      const orders = await shopify.searchOrdersByName(orderName);
      if (!orders || orders.length === 0) {
        return NextResponse.json(
          { error: `Order ${orderName} not found` },
          { status: 404 }
        );
      }
      numericOrderId = orders[0].id;
    }

    if (!numericOrderId) {
      return NextResponse.json(
        { error: "Could not resolve order ID from orderId or orderName" },
        { status: 400 }
      );
    }

    // If fulfillmentOrderId not provided but we have lineItems, try to get it from the order
    if (!resolvedFulfillmentOrderId && lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
      try {
        const fulfillmentOrders = await shopify.getFulfillmentOrders(numericOrderId);
        const openFulfillmentOrder = fulfillmentOrders.find(
          (fo: any) => fo.status === "open" || fo.status === "in_progress"
        );
        if (openFulfillmentOrder) {
          resolvedFulfillmentOrderId = openFulfillmentOrder.id;
        }
      } catch (err) {
        console.warn("[Actions] Failed to fetch fulfillment orders:", err);
      }
    }

    if (!resolvedFulfillmentOrderId) {
      return NextResponse.json(
        { error: "fulfillmentOrderId is required or could not be resolved from order" },
        { status: 400 }
      );
    }

    // For manual fulfillment, tracking number is required
    if (fulfillmentType === 'manual' && !trackingNumber) {
      return NextResponse.json(
        { error: "trackingNumber is required for manual fulfillment" },
        { status: 400 }
      );
    }

    // For GPS fulfillment, tracking might come later, so it's optional
    if (!trackingNumber && fulfillmentType !== 'gps') {
      return NextResponse.json(
        { error: "trackingNumber is required" },
        { status: 400 }
      );
    }

    // Build tracking info compatible with Shopify client (only for manual fulfillment)
    const trackingInfo = trackingNumber ? {
      number: trackingNumber as string,
      company: carrier || "Other",
      url: getTrackingUrl(carrier || "", trackingNumber as string),
    } : undefined;

    // If lineItems provided, map to expected shape for createFulfillment
    const fulfillmentLineItems =
      Array.isArray(lineItems) && lineItems.length > 0
        ? lineItems.map((item: any) => ({
            id: item.id,
            quantity: item.quantity,
          }))
        : undefined;

    // For GPS fulfillment without tracking, we might need different handling
    // For now, if no tracking info, we'll still create fulfillment but without tracking
    const fulfillment = await shopify.createFulfillment(
      resolvedFulfillmentOrderId,
      trackingInfo || { number: "", company: "Other" }, // Provide minimal tracking if none
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


