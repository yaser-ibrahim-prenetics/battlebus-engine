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
import * as gps from "@/lib/clients/gps";
import { mapGpsCarrierToShopify, getTrackingUrl } from "@/lib/helpers/tracking";

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

    // Fetch fulfillment orders to resolve fulfillmentOrderId and map line items
    let fulfillmentOrders: any[] = [];
    let openFulfillmentOrder: any = null;
    
    try {
      fulfillmentOrders = await shopify.getFulfillmentOrders(numericOrderId);
      openFulfillmentOrder = fulfillmentOrders.find(
        (fo: any) => fo.status === "open" || fo.status === "in_progress"
      );
      
      // If fulfillmentOrderId not provided but we have an open fulfillment order, use it
      if (!resolvedFulfillmentOrderId && openFulfillmentOrder) {
        resolvedFulfillmentOrderId = openFulfillmentOrder.id;
      }
    } catch (err) {
      console.warn("[Actions] Failed to fetch fulfillment orders:", err);
    }

    if (!resolvedFulfillmentOrderId) {
      return NextResponse.json(
        { error: "fulfillmentOrderId is required or could not be resolved from order" },
        { status: 400 }
      );
    }

    // Find the specific fulfillment order we're using
    const targetFulfillmentOrder = fulfillmentOrders.find(
      (fo: any) => fo.id === resolvedFulfillmentOrderId
    ) || openFulfillmentOrder;

    if (!targetFulfillmentOrder) {
      return NextResponse.json(
        { error: `Fulfillment order ${resolvedFulfillmentOrderId} not found` },
        { status: 404 }
      );
    }

    // Build tracking info based on fulfillment type
    let trackingInfo: { number: string; company: string; url?: string };
    
    if (fulfillmentType === 'gps') {
      // For GPS fulfillment, fetch tracking info from GPS API
      try {
        // Get GPS order metafield from Shopify order
        const gpsMetafield = await shopify.getGpsOrderMetafield(numericOrderId);
        
        if (!gpsMetafield) {
          return NextResponse.json(
            { error: "GPS order metafield not found. Order may not be a GPS order." },
            { status: 400 }
          );
        }

        // Get GPS order details to fetch tracking info
        const { response: gpsResponse } = await gps.getOutboundOrdersDetails(
          [gpsMetafield.gpsOrderId],
          gpsMetafield.warehouse as "GPS Warehouse" | "GPS UK Warehouse"
        );

        if (!gpsResponse.data || gpsResponse.code !== 200 || !gpsResponse.data[0]) {
          return NextResponse.json(
            { error: `Failed to get GPS order details: ${gpsResponse.msg || "Unknown error"}` },
            { status: 500 }
          );
        }

        const gpsOrder = gpsResponse.data[0];
        
        // Check if GPS order is fulfilled (status 3)
        if (gpsOrder.status !== 3) {
          return NextResponse.json(
            { error: `GPS order ${gpsMetafield.gpsOrderId} is not fulfilled yet (status: ${gpsOrder.status})` },
            { status: 400 }
          );
        }

        // Use tracking info from GPS
        const gpsTrackingNumber = gpsOrder.logisticsTrackNo || "";
        const gpsCarrier = gpsOrder.logisticsCarrier || "Other";
        
        if (!gpsTrackingNumber) {
          return NextResponse.json(
            { error: "GPS order is fulfilled but tracking number is not available yet" },
            { status: 400 }
          );
        }

        trackingInfo = {
          number: gpsTrackingNumber,
          company: mapGpsCarrierToShopify(gpsCarrier),
          url: getTrackingUrl(gpsCarrier, gpsTrackingNumber),
        };

        console.log(`[Actions] Fetched GPS tracking info: ${gpsTrackingNumber} (${gpsCarrier}) for order ${numericOrderId}`);
      } catch (error) {
        console.error("[Actions] Error fetching GPS tracking info:", error);
        return NextResponse.json(
          { error: "Failed to fetch GPS tracking information", message: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }
    } else {
      // For manual fulfillment, use tracking info from API payload
      if (!trackingNumber) {
        return NextResponse.json(
          { error: "trackingNumber is required for manual fulfillment" },
          { status: 400 }
        );
      }
      
      trackingInfo = {
        number: trackingNumber as string,
        company: carrier || "Other",
        url: getTrackingUrl(carrier || "", trackingNumber as string),
      };
    }

    // Map order line items to fulfillment order line items
    // The lineItems from battle-cs contain order line item IDs, but we need fulfillment order line item IDs
    // Following spock-store pattern: if we can't map correctly, omit line items and let Shopify fulfill all
    let fulfillmentLineItems: Array<{ id: number; quantity: number }> | undefined;
    
    if (Array.isArray(lineItems) && lineItems.length > 0 && targetFulfillmentOrder?.line_items) {
      fulfillmentLineItems = [];
      
      for (const requestedItem of lineItems) {
        // Find the fulfillment order line item that matches this order line item
        // Match by line_item_id (which is the order line item ID)
        const fulfillmentLineItem = targetFulfillmentOrder.line_items.find(
          (foItem: any) => foItem.line_item_id === requestedItem.id
        );
        
        if (fulfillmentLineItem) {
          fulfillmentLineItems.push({
            id: fulfillmentLineItem.id, // Use fulfillment order line item ID
            quantity: Math.min(requestedItem.quantity, fulfillmentLineItem.fulfillable_quantity || fulfillmentLineItem.quantity),
          });
        } else {
          console.warn(`[Actions] Order line item ${requestedItem.id} not found in fulfillment order ${resolvedFulfillmentOrderId}`);
        }
      }
      
      // If we couldn't map all requested items correctly, omit line items entirely
      // This follows spock-store pattern: let Shopify fulfill all items in the fulfillment order
      if (fulfillmentLineItems.length !== lineItems.length) {
        console.warn(`[Actions] Could not map all line items (${fulfillmentLineItems.length}/${lineItems.length}), omitting line items to fulfill all items in fulfillment order`);
        fulfillmentLineItems = undefined; // Let Shopify fulfill all items
      }
    }
    // If no line items specified, don't provide any - Shopify will fulfill all fulfillable items

    // Create fulfillment with tracking info, fulfillmentType, and platform
    // Always send tracking info (even if empty for GPS - can be updated later)
    const fulfillment = await shopify.createFulfillment(
      resolvedFulfillmentOrderId,
      trackingInfo,
      fulfillmentLineItems,
      fulfillmentType || "manual",
      platform || "shopify"
    );

    // Store fulfillmentType and platform as order metafields for tracking
    try {
      if (fulfillmentType || platform) {
        await shopify.setFulfillmentMetadata(
          numericOrderId,
          fulfillment.id,
          fulfillmentType || "manual",
          platform || "shopify"
        );
      }
    } catch (err) {
      console.warn("[Actions] Failed to set fulfillment metadata:", err);
      // Don't fail the request if metadata setting fails
    }

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


