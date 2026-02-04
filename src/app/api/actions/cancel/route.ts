// ============================================================================
// ORDER CANCELLATION ACTION API (Battle Bus)
// ============================================================================
// Cancels a Shopify order using Battle Bus Shopify configuration.
// Intended to be called from battle-cs; downstream systems are updated
// via Shopify webhooks and Inngest functions.

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderId, orderName, reason, email, refund } = body ?? {};

    if (!orderId && !orderName) {
      return NextResponse.json(
        { error: "orderId or orderName is required" },
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

    // Helper to actually call Shopify cancel for a numeric order ID
    const cancelByNumericId = async (
      numericOrderId: number
    ): Promise<Response> => {
      return fetch(
        `https://${shopDomain}/admin/api/${apiVersion}/orders/${numericOrderId}/cancel.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            reason: reason || "other",
            email: email !== false,
            refund: refund || false,
          }),
        }
      );
    };

    let response: Response | null = null;
    let result: any = null;

    // 1. If we have a numeric orderId, try cancelling directly first.
    const numericIdFromOrderId =
      orderId != null && Number.isFinite(Number(orderId))
        ? Number(orderId)
        : null;

    if (numericIdFromOrderId != null) {
      response = await cancelByNumericId(numericIdFromOrderId);
      result = await response.json().catch(() => ({}));

      // If success, return immediately
      if (response.ok) {
        return NextResponse.json(
          {
            success: true,
            message: "Order cancelled via Battle Bus",
            data: result.order ?? result,
          },
          { status: 200 }
        );
      }
    }

    // 2. If cancel by numeric ID failed with 404 (or there was no valid numeric ID)
    // and we have an orderName, fall back to resolving by name.
    if (orderName) {
      const orders = await shopify.searchOrdersByName(orderName);
      if (!orders || orders.length === 0) {
        // If we already have a response from the numeric attempt, surface that,
        // otherwise return not-found for the name as well.
        if (response) {
          return NextResponse.json(
            {
              error: "Failed to cancel order in Shopify",
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
      response = await cancelByNumericId(numericFromName);
      result = await response.json().catch(() => ({}));

      if (!response.ok) {
        return NextResponse.json(
          {
            error: "Failed to cancel order in Shopify",
            details: result,
          },
          { status: response.status }
        );
      }

      return NextResponse.json(
        {
          success: true,
          message: "Order cancelled via Battle Bus",
          data: result.order ?? result,
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
    console.error("[Actions] Error cancelling order:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


