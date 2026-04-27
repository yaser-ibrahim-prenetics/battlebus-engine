// ============================================================================
// INNGEST RERUN API (Battle Bus)
// ============================================================================
// Allows battle-hub to trigger event reruns via the Inngest client
// This endpoint fetches the order from Shopify and sends a new event
// Inngest's durable execution will skip already-completed steps

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { searchOrdersByName } from "@/lib/clients/shopify";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { runId, eventId, functionId, eventName, eventData, orderName } = body;
    const resolveFunctionId = (input: unknown): string | null => {
      const raw = typeof input === "string" ? input.trim() : "";
      if (!raw) return null;
      const aliasMap: Record<string, string> = {
        fulfillment: "process-shopify-fulfillment",
        order_paid: "process-shopify-order",
        order_creation: "process-shopify-order",
        gps_outbound: "process-shopify-order",
        fulfillment_replay: "process-shopify-fulfillment",
        backorder: "process-backorder",
      };
      return aliasMap[raw] || raw;
    };
    const normalizedFunctionId = resolveFunctionId(functionId);

    // If orderName is provided, fetch the order from Shopify and trigger reprocess
    if (orderName) {
      // Shopify order names include the # prefix (e.g., #IM8-14931)
      // Ensure we search with the correct format
      const searchName = orderName.startsWith("#") ? orderName : `#${orderName}`;
      console.log(`[Inngest Rerun] Fetching order ${searchName} from Shopify for reprocess`);

      // Fetch the full order from Shopify
      const orders = await searchOrdersByName(searchName);
      const shopifyOrder = orders?.[0];

      if (!shopifyOrder) {
        return NextResponse.json(
          { error: `Order ${orderName} not found in Shopify` },
          { status: 404 }
        );
      }

      // Build event payload - DO NOT spread eventData as it may contain
      // conflicting fields like orderId that would overwrite shopifyOrderId
      // IMPORTANT: Append timestamp to shopifyOrderId to bypass idempotency for reruns
      // The function uses idempotency: "event.data.shopifyOrderId" which would
      // otherwise deduplicate and skip the rerun
      const rerunTimestamp = Date.now();
      const eventPayload = {
        name: eventName || "shopify/order.paid",
        data: {
          // Append rerun timestamp to make idempotency key unique
          shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
          // Keep original ID for reference
          originalShopifyOrderId: String(shopifyOrder.id),
          shopifyOrderName: shopifyOrder.name,
          shopifyStore: "im8-battle-bus",
          orderJson: shopifyOrder,
          reprocessedAt: new Date().toISOString(),
          source: "battle-hub",
          receivedAt: new Date().toISOString(),
          isRerun: true,
          // Only include safe fields from eventData
          ...(eventData?.fromStart !== undefined && { fromStart: eventData.fromStart }),
        },
      };

      // Send the event using the Inngest client
      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Reprocess event sent for order ${orderName}`,
        eventId: result.ids?.[0],
      });
    }

    // If eventId is provided (Firestore order ID), we need to look up the order name first
    if (eventId && eventData?.orderName) {
      // If orderName is in eventData, use that to fetch from Shopify
      // Shopify order names include the # prefix (e.g., #IM8-14931)
      const rawOrderName = eventData.orderName;
      const shopifyOrderName = rawOrderName.startsWith("#") ? rawOrderName : `#${rawOrderName}`;
      console.log(`[Inngest Rerun] Fetching order ${shopifyOrderName} from Shopify`);

      const orders = await searchOrdersByName(shopifyOrderName);
      const shopifyOrder = orders?.[0];

      if (!shopifyOrder) {
        return NextResponse.json(
          { error: `Order ${shopifyOrderName} not found in Shopify` },
          { status: 404 }
        );
      }

      // Append timestamp to bypass idempotency for reruns
      const rerunTimestamp = Date.now();
      const eventPayload = {
        name: eventName || "shopify/order.paid",
        data: {
          shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
          originalShopifyOrderId: String(shopifyOrder.id),
          shopifyOrderName: shopifyOrder.name,
          shopifyStore: "im8-battle-bus",
          orderJson: shopifyOrder,
          reprocessedAt: new Date().toISOString(),
          source: "battle-hub",
          receivedAt: new Date().toISOString(),
          isRerun: true,
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Rerun event sent for order ${shopifyOrderName}`,
        eventId: result.ids?.[0],
      });
    }

    // Legacy: If only eventId is provided without orderName, send a generic rerun event
    if (eventId) {
      console.warn(`[Inngest Rerun] eventId provided without orderName - this may fail validation`);
      const eventPayload = {
        name: eventName || "support/rerun",
        data: {
          eventId,
          rerunAt: new Date().toISOString(),
          source: "battle-hub",
          ...eventData,
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Rerun event sent for eventId ${eventId}`,
        eventId: result.ids?.[0],
      });
    }

    // If runId is provided, we need to use the Inngest API directly
    // This requires the signing key for authentication
    if (runId) {
      const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY;

      if (!INNGEST_SIGNING_KEY) {
        return NextResponse.json({ error: "INNGEST_SIGNING_KEY not configured" }, { status: 500 });
      }

      const response = await fetch(`https://api.inngest.com/v1/runs/${runId}/rerun`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INNGEST_SIGNING_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(normalizedFunctionId && { function_id: normalizedFunctionId }),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return NextResponse.json(
          { error: `Inngest API error: ${error}` },
          { status: response.status }
        );
      }

      const data = await response.json();
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json(
      { error: "Either runId, eventId, or orderName is required" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Inngest Rerun] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
