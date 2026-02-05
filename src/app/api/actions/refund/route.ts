// ============================================================================
// ORDER REFUND ACTION API (Battle Bus)
// ============================================================================
// Creates a Shopify refund (full, partial amount, or per-line) using Battle Bus
// Shopify configuration. Called from battle-cs; downstream D365 credit note,
// etc. are handled by Battle Bus via Shopify webhooks and Inngest.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";

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

      if (Array.isArray(refundLineItems) && refundLineItems.length > 0) {
        // Line item refund - set restock_type on each line item
        refund.refund_line_items = refundLineItems.map((item: any) => ({
          line_item_id: item.lineItemId || item.id, // Support both field names
          quantity: item.quantity,
          // restock_type: 'no_restock' | 'cancel' | 'return' | 'legacy_restock'
          // If restock was requested, use 'return', otherwise 'cancel' (default)
          restock_type: item.restockType || (restock === true ? "return" : restock === false ? "no_restock" : "cancel"),
        }));
      } else {
        // For full refund or amount refund, if restock is specified, we need to fetch order line items
        // and create refund_line_items with restock_type
        if (restock !== undefined) {
          try {
            const order = await shopify.getOrder(numericOrderId);
            if (order.line_items && order.line_items.length > 0) {
              refund.refund_line_items = order.line_items.map((item: any) => ({
                line_item_id: item.id,
                quantity: item.quantity,
                restock_type: restock === true ? "return" : restock === false ? "no_restock" : "cancel",
              }));
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
        return NextResponse.json(
          {
            success: true,
            message: "Refund created via Battle Bus",
            data: result.refund ?? result,
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

      return NextResponse.json(
        {
          success: true,
          message: "Refund created via Battle Bus",
          data: result.refund ?? result,
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


