// ============================================================================
// ORDER REFUND ACTION API (Battle Bus)
// ============================================================================
// Creates a Shopify refund (full, partial amount, or per-line) using Battle Bus
// Shopify configuration. Sends an Inngest event for real-time tracking.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import { inngest } from "@/inngest/client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      orderId,
      orderName,
      amount,
      reason,
      note,
      refundLineItems,
      restock,
      notify,
      location_id, // location_id from battle-cs (extracted from order details)
    } = body ?? {};

    if (!orderId && !orderName) {
      return NextResponse.json(
        { error: "orderName or orderId is required" },
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

    const buildRefundPayload = async (numericOrderId: number): Promise<any> => {
      const refund: any = {
        note: note || reason || "Refund processed by support",
        notify: notify !== false,
        // Note: restock field is deprecated - use restock_type on refund_line_items instead
      };

      // Use location_id from request payload (sent by battle-cs), or fetch it as fallback
      let locationId: number | null = location_id ? Number(location_id) : null;
      
      // If location_id not provided in payload, try to fetch it from order
      if (!locationId) {
        try {
          const order = await shopify.getOrder(numericOrderId);
          // Get location from first fulfillment (order may have fulfillments in API response)
          const orderWithFulfillments = order as any;
          if (orderWithFulfillments.fulfillments && orderWithFulfillments.fulfillments.length > 0) {
            locationId = orderWithFulfillments.fulfillments[0].location_id || null;
          }
          
          // If no fulfillment location, try to get from fulfillment orders
          if (!locationId) {
            try {
              const fulfillmentOrders = await shopify.getFulfillmentOrders(numericOrderId);
              if (fulfillmentOrders.length > 0 && fulfillmentOrders[0].assigned_location_id) {
                locationId = fulfillmentOrders[0].assigned_location_id;
              }
            } catch (err) {
              console.warn("[Actions] Failed to get location from fulfillment orders:", err);
            }
          }

          // If still no location, use GPS location as fallback (most common)
          if (!locationId && config.shopify.im8.locations?.gps) {
            locationId = Number(config.shopify.im8.locations.gps);
            console.warn(`[Actions] Using fallback GPS location ${locationId} for refund restock`);
          }
        } catch (err) {
          console.warn("[Actions] Failed to fetch order for location, proceeding without location:", err);
        }
      } else {
        console.log(`[Actions] Using location_id ${locationId} from request payload`);
      }

      if (Array.isArray(refundLineItems) && refundLineItems.length > 0) {
        // Line item refund - set restock_type on each line item
        const restockType = refundLineItems[0]?.restockType || (restock === true ? "return" : restock === false ? "no_restock" : "cancel");
        const needsLocation = restockType !== "no_restock";
        
        refund.refund_line_items = refundLineItems.map((item: any) => {
          const itemRestockType = item.restockType || restockType;
          const refundLineItem: any = {
            line_item_id: item.lineItemId || item.id, // Support both field names
            quantity: item.quantity,
            restock_type: itemRestockType,
          };
          
          // Add location_id if restocking (required by Shopify)
          // Priority: item.location_id (from payload) > locationId (from order/fallback)
          if (needsLocation) {
            if (item.location_id || item.locationId) {
              // Use location_id from the line item itself (highest priority)
              refundLineItem.location_id = item.location_id || item.locationId;
            } else if (locationId) {
              // Use location_id from order or fallback
              refundLineItem.location_id = locationId;
            } else {
              console.warn(`[Actions] No location_id found for restock refund line item ${item.lineItemId || item.id}`);
            }
          }
          
          return refundLineItem;
        });
      } else {
        // For full refund or amount refund, if restock is specified, we need to fetch order line items
        // and create refund_line_items with restock_type
        if (restock !== undefined) {
          try {
            const order = await shopify.getOrder(numericOrderId);
            if (order.line_items && order.line_items.length > 0) {
              const restockType = restock === true ? "return" : restock === false ? "no_restock" : "cancel";
              refund.refund_line_items = order.line_items.map((item: any) => {
                const refundLineItem: any = {
                  line_item_id: item.id,
                  quantity: item.quantity,
                  restock_type: restockType,
                };
                
                // Add location_id if restocking (required by Shopify)
                if (restockType !== "no_restock" && locationId) {
                  refundLineItem.location_id = locationId;
                }
                
                return refundLineItem;
              });
            }
          } catch (err) {
            console.warn("[Actions] Failed to fetch order for restock refund, proceeding without restock control:", err);
          }
        }

        if (amount) {
          // Amount-based refund (partial refund)
          refund.amount = String(amount);
        } else {
          // Full refund
          refund.full_refund = true;
        }
      }

      return refund;
    };

    const createRefundByNumericId = async (
      numericOrderId: number
    ): Promise<Response> => {
      const refund = await buildRefundPayload(numericOrderId);

      return fetch(
        `https://${shopDomain}/admin/api/${apiVersion}/orders/${numericOrderId}/refunds.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ refund }),
        }
      );
    };

    let response: Response | null = null;
    let result: any = null;

    // 1. If we have a numeric orderId, try refunding directly first.
    const numericIdFromOrderId =
      orderId != null && Number.isFinite(Number(orderId))
        ? Number(orderId)
        : null;

    if (numericIdFromOrderId != null) {
      response = await createRefundByNumericId(numericIdFromOrderId);
      result = await response.json().catch(() => ({}));

      if (response.ok) {
        const refundData = result.refund ?? result;
        const eventId = `action-refund-${numericIdFromOrderId}-${Date.now()}`;
        
        // Send Inngest event for real-time tracking
        await inngest.send({
          id: eventId,
          name: "action/order.refund",
          data: {
            shopifyOrderId: String(numericIdFromOrderId),
            shopifyOrderName: orderName || `#${numericIdFromOrderId}`,
            refundId: refundData.id ? String(refundData.id) : undefined,
            amount: amount || "full",
            reason: reason || note || "Refund processed by support",
            restock: restock || false,
            refundedAt: new Date().toISOString(),
            source: "battle-hub",
          },
        });

        return NextResponse.json(
          {
            success: true,
            message: "Refund created via Battle Bus",
            data: refundData,
            eventId,
          },
          { status: 200 }
        );
      }
    }

    // 2. If refund by numeric ID failed and we have an orderName, fall back to resolving by name.
    if (orderName) {
      const orders = await shopify.searchOrdersByName(orderName);
      if (!orders || orders.length === 0) {
        if (response) {
          return NextResponse.json(
            {
              error: "Failed to create refund in Shopify",
              details: result,
            },
            { status: response.status }
          );
        }

        return NextResponse.json(
          { error: `Order ${orderName} not found` },
          { status: 404 }
        );
      }

      const numericFromName = orders[0].id;
      response = await createRefundByNumericId(numericFromName);
      result = await response.json().catch(() => ({}));

      if (!response.ok) {
        return NextResponse.json(
          {
            error: "Failed to create refund in Shopify",
            details: result,
          },
          { status: response.status }
        );
      }

      const refundData = result.refund ?? result;
      const eventId = `action-refund-${numericFromName}-${Date.now()}`;
      
      // Send Inngest event for real-time tracking
      await inngest.send({
        id: eventId,
        name: "action/order.refund",
        data: {
          shopifyOrderId: String(numericFromName),
          shopifyOrderName: orderName || `#${numericFromName}`,
          refundId: refundData.id ? String(refundData.id) : undefined,
          amount: amount || "full",
          reason: reason || note || "Refund processed by support",
          restock: restock || false,
          refundedAt: new Date().toISOString(),
          source: "battle-hub",
        },
      });

      return NextResponse.json(
        {
          success: true,
          message: "Refund created via Battle Bus",
          data: refundData,
          eventId,
        },
        { status: 200 }
      );
    }

    // 3. If we got here, we only had a non-numeric orderId and no orderName.
    return NextResponse.json(
      { error: "Invalid orderId and no orderName provided" },
      { status: 400 }
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


