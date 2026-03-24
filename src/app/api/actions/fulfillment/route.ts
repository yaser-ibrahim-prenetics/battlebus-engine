// ============================================================================
// ORDER FULFILLMENT ACTION API (Battle Bus)
// ============================================================================
// Creates a Shopify fulfillment using existing Shopify client utilities.
// Sends an Inngest event for real-time tracking and downstream processing.
//
// Flow:
//   battle-hub → /api/actions/fulfillment → Shopify
//   → Inngest event for real-time tracking
//   → Shopify webhooks → additional Inngest functions (D365, GPS, etc.)

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import * as gps from "@/lib/clients/gps";
import { mapGpsCarrierToShopify, getTrackingUrl } from "@/lib/helpers/tracking";
import { inngest } from "@/inngest/client";

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
    let resolvedFulfillmentOrderId: number | undefined = fulfillmentOrderId
      ? Number(fulfillmentOrderId)
      : undefined;

    // Try to resolve order ID with fallback logic (same as cancel/refund)
    if (orderId) {
      const numericId = Number(orderId);
      if (Number.isFinite(numericId) && !isNaN(numericId)) {
        // It's a valid numeric ID, try to use it
        numericOrderId = numericId;
      } else if (platform === "shopify" && orderName) {
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
        return NextResponse.json({ error: `Order ${orderName} not found` }, { status: 404 });
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
    let targetFulfillmentOrder =
      fulfillmentOrders.find((fo: any) => fo.id === resolvedFulfillmentOrderId) ||
      openFulfillmentOrder;

    if (!targetFulfillmentOrder) {
      return NextResponse.json(
        { error: `Fulfillment order ${resolvedFulfillmentOrderId} not found` },
        { status: 404 }
      );
    }

    // Re-fetch fulfillment orders if we need to map line items (to ensure we have latest data)
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      try {
        const freshFulfillmentOrders = await shopify.getFulfillmentOrders(numericOrderId);
        const freshTargetFulfillmentOrder = freshFulfillmentOrders.find(
          (fo: any) => fo.id === resolvedFulfillmentOrderId
        );
        if (freshTargetFulfillmentOrder) {
          targetFulfillmentOrder = freshTargetFulfillmentOrder;
          console.log(
            `[Actions] Re-fetched fulfillment order ${resolvedFulfillmentOrderId} for line item mapping`
          );
        }
      } catch (err) {
        console.warn(
          "[Actions] Failed to re-fetch fulfillment orders for line item mapping, using cached data:",
          err
        );
      }
    }

    // Build tracking info based on fulfillment type
    let trackingInfo: { number: string; company: string; url?: string };

    if (fulfillmentType === "gps") {
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
            {
              error: `GPS order ${gpsMetafield.gpsOrderId} is not fulfilled yet (status: ${gpsOrder.status})`,
            },
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

        console.log(
          `[Actions] Fetched GPS tracking info: ${gpsTrackingNumber} (${gpsCarrier}) for order ${numericOrderId}`
        );
      } catch (error) {
        console.error("[Actions] Error fetching GPS tracking info:", error);
        return NextResponse.json(
          {
            error: "Failed to fetch GPS tracking information",
            message: error instanceof Error ? error.message : String(error),
          },
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

    if (Array.isArray(lineItems) && lineItems.length > 0) {
      if (!targetFulfillmentOrder?.line_items || targetFulfillmentOrder.line_items.length === 0) {
        console.warn(
          `[Actions] Fulfillment order ${resolvedFulfillmentOrderId} has no line items, will fulfill all items`
        );
        fulfillmentLineItems = undefined;
      } else {
        fulfillmentLineItems = [];

        console.log(
          `[Actions] Mapping ${lineItems.length} requested line items to fulfillment order line items`
        );
        console.log(`[Actions] Requested line items:`, JSON.stringify(lineItems));
        console.log(
          `[Actions] Fulfillment order has ${targetFulfillmentOrder.line_items.length} line items`
        );
        console.log(
          `[Actions] Fulfillment order line items:`,
          JSON.stringify(
            targetFulfillmentOrder.line_items.map((li: any) => ({
              id: li.id,
              line_item_id: li.line_item_id,
              fulfillable_quantity: li.fulfillable_quantity,
            }))
          )
        );

        for (const requestedItem of lineItems) {
          // Convert to numbers for comparison (handle string/number mismatches)
          const requestedId = Number(requestedItem.id);

          // Find the fulfillment order line item that matches this order line item
          // Match by line_item_id (which is the order line item ID)
          const fulfillmentLineItem = targetFulfillmentOrder.line_items.find(
            (foItem: any) => Number(foItem.line_item_id) === requestedId
          );

          if (fulfillmentLineItem) {
            const fulfillableQty =
              fulfillmentLineItem.fulfillable_quantity || fulfillmentLineItem.quantity || 0;
            const requestedQty = Number(requestedItem.quantity) || 1;
            const finalQty = Math.min(requestedQty, fulfillableQty);

            fulfillmentLineItems.push({
              id: Number(fulfillmentLineItem.id), // Use fulfillment order line item ID (must be numeric)
              quantity: finalQty,
            });

            console.log(
              `[Actions] Mapped order line item ${requestedId} to fulfillment line item ${fulfillmentLineItem.id} (qty: ${finalQty})`
            );
          } else {
            console.warn(
              `[Actions] Order line item ${requestedId} not found in fulfillment order ${resolvedFulfillmentOrderId}`
            );
            console.warn(
              `[Actions] Available line_item_ids in fulfillment order:`,
              targetFulfillmentOrder.line_items.map((li: any) => li.line_item_id)
            );
          }
        }

        // If we couldn't map all requested items correctly, omit line items entirely
        // This follows spock-store pattern: let Shopify fulfill all items in the fulfillment order
        if (fulfillmentLineItems.length !== lineItems.length) {
          console.warn(
            `[Actions] Could not map all line items (${fulfillmentLineItems.length}/${lineItems.length}), omitting line items to fulfill all items in fulfillment order`
          );
          fulfillmentLineItems = undefined; // Let Shopify fulfill all items
        } else {
          console.log(
            `[Actions] Successfully mapped all ${fulfillmentLineItems.length} line items`
          );
        }
      }
    }
    // If no line items specified, don't provide any - Shopify will fulfill all fulfillable items

    // Create fulfillment with tracking info, fulfillmentType, and platform
    // Always send tracking info (even if empty for GPS - can be updated later)
    // Only send line items if we successfully mapped them all
    console.log(
      `[Actions] Creating fulfillment with ${fulfillmentLineItems ? fulfillmentLineItems.length : "all"} line items`
    );

    const fulfillment = await shopify.createFulfillment(
      resolvedFulfillmentOrderId,
      trackingInfo,
      fulfillmentLineItems, // undefined if mapping failed - will fulfill all items
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

    // Send Inngest event for real-time tracking
    const eventId = `action-fulfill-${numericOrderId}-${Date.now()}`;
    const resolvedOrderName = orderName || `#${numericOrderId}`;

    await inngest.send({
      id: eventId,
      name: "action/order.fulfill",
      data: {
        shopifyOrderId: String(numericOrderId),
        shopifyOrderName: resolvedOrderName,
        fulfillmentId: fulfillment.id ? String(fulfillment.id) : undefined,
        fulfillmentType: fulfillmentType || "manual",
        platform: platform || "shopify",
        trackingNumber: trackingInfo.number,
        carrier: trackingInfo.company,
        fulfilledAt: new Date().toISOString(),
        source: "battle-hub",
      },
    });

    // Emit canonical shopify/order.fulfilled so D365 sync runs immediately,
    // even for GPS orders (which are normally skipped from webhook echo).
    // Mirrors the cancel route pattern (action event + canonical event).
    await inngest.send({
      id: `shopify-order-fulfilled-manual-${numericOrderId}-${Date.now()}`,
      name: "shopify/order.fulfilled",
      data: {
        shopifyOrderId: String(numericOrderId),
        shopifyOrderName: resolvedOrderName,
        shopifyStore: config.shopify.im8.shopDomain || "im8",
        orderJson: null,
        fulfillments: [
          {
            id: fulfillment.id,
            location_id: locationId || targetFulfillmentOrder?.assigned_location_id || null,
            tracking_number: trackingInfo.number,
            tracking_company: trackingInfo.company,
            tracking_url: trackingInfo.url || null,
            line_items: targetFulfillmentOrder?.line_items?.map((li: any) => ({
              id: li.line_item_id,
              sku: li.sku || li.variant_sku || "",
              quantity: li.quantity || li.fulfillable_quantity || 1,
            })) || [],
            created_at: new Date().toISOString(),
          },
        ],
        fromManualFulfillment: true,
        receivedAt: new Date().toISOString(),
        source: "battle-hub-action",
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: "Fulfillment created via Battle Bus",
        data: fulfillment,
        eventId,
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
