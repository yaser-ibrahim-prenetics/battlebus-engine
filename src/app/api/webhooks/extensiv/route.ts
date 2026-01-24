// ============================================================================
// EXTENSIV WEBHOOK HANDLER
// ============================================================================
// Receives webhooks from Extensiv (3PL Central) for order confirmations and returns

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import * as extensiv from "@/lib/clients/extensiv";

// Cache for webhook public key
let cachedPublicKey: string | null = null;
let publicKeyFetchedAt = 0;
const PUBLIC_KEY_TTL_MS = 3600000; // 1 hour

async function getPublicKey(): Promise<string> {
  const now = Date.now();
  if (cachedPublicKey && now - publicKeyFetchedAt < PUBLIC_KEY_TTL_MS) {
    return cachedPublicKey;
  }
  cachedPublicKey = await extensiv.getWebhookPublicKey();
  publicKeyFetchedAt = now;
  return cachedPublicKey;
}

export async function POST(request: NextRequest) {
  const requestId = `extensiv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  console.log(`[Extensiv Webhook] [${requestId}] Received webhook`);

  try {
    // Get raw body for signature verification
    const rawBody = await request.text();
    const signature = request.headers.get("signature");

    console.log(`[Extensiv Webhook] [${requestId}] Signature present: ${!!signature}`);

    // Verify signature
    if (!config.extensiv.disableWebhookVerification) {
      if (!signature) {
        console.error(`[Extensiv Webhook] [${requestId}] Missing signature header`);
        return NextResponse.json(
          { error: "Missing signature", requestId },
          { status: 401 }
        );
      }

      const publicKey = await getPublicKey();
      const isValid = extensiv.verifyWebhookSignature(rawBody, signature, publicKey);

      if (!isValid) {
        console.error(`[Extensiv Webhook] [${requestId}] Invalid signature`);
        return NextResponse.json(
          { error: "Invalid signature", requestId },
          { status: 401 }
        );
      }

      console.log(`[Extensiv Webhook] [${requestId}] Signature verified`);
    } else {
      console.warn(`[Extensiv Webhook] [${requestId}] Signature verification disabled`);
    }

    // Parse event
    const event = extensiv.parseWebhookEvent(JSON.parse(rawBody));
    const { wmsEventId, eventType, resource } = event;

    console.log(`[Extensiv Webhook] [${requestId}] Event type: ${eventType}, WMS Event ID: ${wmsEventId}`);

    // Route based on event type
    switch (eventType) {
      case "OrderConfirm": {
        const orderConfirm = resource.body as extensiv.ExtensivOrderConfirm;
        const { referenceNum, readOnly, routingInfo } = orderConfirm;

        console.log(`[Extensiv Webhook] [${requestId}] OrderConfirm for ${referenceNum}`);

        // Determine data area ID based on facility
        // Charlotte Warehouse = U001
        const dataAreaId = "U001";

        await inngest.send({
          name: "extensiv/order.confirm",
          data: {
            wmsEventId,
            extensivOrderId: readOnly.orderId.toString(),
            shopifyOrderName: referenceNum,
            trackingNumber: routingInfo.trackingNumber,
            carrier: routingInfo.carrier,
            dataAreaId,
            eventJson: orderConfirm,
            receivedAt: new Date().toISOString(),
          },
        });

        console.log(`[Extensiv Webhook] [${requestId}] Sent extensiv/order.confirm event`);
        break;
      }

      case "ReceiverConfirm": {
        const receiverConfirm = resource.body as extensiv.ExtensivReceiverConfirm;
        const { referenceNum, readOnly } = receiverConfirm;

        console.log(`[Extensiv Webhook] [${requestId}] ReceiverConfirm for ${referenceNum}`);

        await inngest.send({
          name: "extensiv/receiver.confirm",
          data: {
            wmsEventId,
            receiverId: readOnly.receiverId.toString(),
            referenceNum,
            eventJson: receiverConfirm,
            receivedAt: new Date().toISOString(),
          },
        });

        console.log(`[Extensiv Webhook] [${requestId}] Sent extensiv/receiver.confirm event`);
        break;
      }

      case "InventorySummaryUpdate": {
        console.log(`[Extensiv Webhook] [${requestId}] InventorySummaryUpdate - not processed`);
        break;
      }

      default:
        console.warn(`[Extensiv Webhook] [${requestId}] Unknown event type: ${eventType}`);
    }

    return NextResponse.json({
      success: true,
      requestId,
      eventType,
      wmsEventId,
    });
  } catch (error) {
    console.error(`[Extensiv Webhook] [${requestId}] Error:`, error);
    return NextResponse.json(
      {
        error: "Internal server error",
        requestId,
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "extensiv-webhook",
    enabled: config.extensiv.enabled,
    verificationEnabled: !config.extensiv.disableWebhookVerification,
  });
}

