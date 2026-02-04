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

    const buildRefundPayload = (): any => {
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

      return refund;
    };

    const createRefundByNumericId = async (
      numericOrderId: number
    ): Promise<Response> => {
      const refund = buildRefundPayload();

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


