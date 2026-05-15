// ============================================================================
// LOOP RETURNS WEBHOOK — parity with spock-store `taskprocessor.processLoopEvent`
// return.closed + positive refund → forward `shopify/refund.created` (synthetic REST payload).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";
import {
  buildSyntheticShopifyRefundFromLoopReturn,
  isLoopReturnClosedPayload,
  loopClosedReturnRefundIsPositive,
  verifyLoopWebhookSignature,
  type LoopReturnRefundWebhookBody,
} from "@/lib/helpers/loop-return-refund";
import type { ShopifyRefundCreatedEvent } from "@/inngest/events";

type RefundCreatedIngressEvent = ShopifyRefundCreatedEvent & { id?: string };

function activeIm8ShopDomainForEvents(): string {
  return (
    config.shopify.im8.shopDomain ||
    config.shopify.test.shopDomain ||
    config.shopify.production.shopDomain ||
    ""
  );
}

async function sendRefundEvent(ev: RefundCreatedIngressEvent, requestId: string): Promise<boolean> {
  try {
    await inngest.send(ev);
    return true;
  } catch (error) {
    console.error(`[LoopWebhook] [${requestId}] Failed to send Inngest event`, error);
    return false;
  }
}

export async function POST(request: NextRequest) {
  const requestId = `loop-webhook-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (!config.features.enableLoopReturnRefundWebhook) {
    console.warn(`[LoopWebhook] [${requestId}] Disabled via ENABLE_LOOP_RETURN_REFUND_WEBHOOK=false`);
    return NextResponse.json(
      { ok: false, error: "loop_return_webhook_disabled", requestId },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-loop-signature");

  logFlowEvent({
    level: "info",
    flow: "loop_webhook",
    step: "received",
    client: "loop",
    requestId,
    status: "started",
    payload: { bodyBytes: rawBody.length, signaturePresent: Boolean(signatureHeader) },
  });

  if (!signatureHeader || typeof signatureHeader !== "string") {
    console.error(`[LoopWebhook] [${requestId}] Missing x-loop-signature`);
    return NextResponse.json({ ok: false, error: "missing_signature", requestId }, { status: 401 });
  }

  const key = config.loop.webhookKey.trim();
  if (!config.loop.disableWebhookVerification) {
    if (!key) {
      console.error(`[LoopWebhook] [${requestId}] LOOP_WEBHOOK_KEY not configured`);
      return NextResponse.json({ ok: false, error: "webhook_secret_not_configured", requestId }, {
        status: 503,
      });
    }
    if (!verifyLoopWebhookSignature(rawBody, key, signatureHeader)) {
      console.error(`[LoopWebhook] [${requestId}] Invalid signature`);
      return NextResponse.json({ ok: false, error: "invalid_signature", requestId }, { status: 401 });
    }
  } else {
    console.warn(`[LoopWebhook] [${requestId}] Verification skipped (DISABLE_LOOP_WEBHOOK_VERIFICATION)`);
    if (key && !verifyLoopWebhookSignature(rawBody, key, signatureHeader)) {
      console.warn(`[LoopWebhook] [${requestId}] Signature mismatch (still accepted while verification disabled)`);
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", requestId }, { status: 400 });
  }

  if (!isLoopReturnClosedPayload(parsed)) {
    console.log(`[LoopWebhook] [${requestId}] Ignoring non-return.closed payload`);
    return NextResponse.json({ ok: true, ignored: true, requestId }, { status: 200 });
  }

  const body = parsed as LoopReturnRefundWebhookBody;
  if (!loopClosedReturnRefundIsPositive(body)) {
    console.log(`[LoopWebhook] [${requestId}] Closed return without positive refund total — no-op`);
    return NextResponse.json({ ok: true, ignored: "no_refund_amount", requestId }, { status: 200 });
  }

  const shopifyStoreDomain = activeIm8ShopDomainForEvents();
  const synthetic = buildSyntheticShopifyRefundFromLoopReturn(body);

  const event: ShopifyRefundCreatedEvent = {
    name: "shopify/refund.created",
    data: {
      shopifyOrderId: String(body.provider_order_id),
      refundId: String(body.id),
      shopifyStore: shopifyStoreDomain,
      refundJson: synthetic,
      receivedAt: new Date().toISOString(),
      refundInitiator: "loop_return_closed",
    },
  };

  const sent = await sendRefundEvent(
    {
      id: `loop-return-refund-${body.id}-${body.trigger}`,
      ...event,
    },
    requestId
  );

  if (!sent) {
    logFlowEvent({
      level: "error",
      flow: "loop_webhook",
      step: "forward_refund_failed",
      client: "loop",
      requestId,
      status: "failed",
      payload: { loopReturnId: body.id, shopifyOrderId: body.provider_order_id },
    });
    return NextResponse.json({ ok: false, error: "inngest_send_failed", requestId }, { status: 502 });
  }

  console.log(
    `[LoopWebhook] [${requestId}] ✅ Forwarded shopify/refund.created for Loop return ${body.id} → order ${body.provider_order_id}`
  );
  logFlowEvent({
    level: "info",
    flow: "loop_webhook",
    step: "forward_refund_created",
    client: "loop",
    requestId,
    status: "completed",
    payload: {
      loopReturnId: body.id,
      shopifyOrderId: body.provider_order_id,
      refundPresentment: body.refund,
    },
  });

  return NextResponse.json({ ok: true, forwarded: true, requestId }, { status: 200 });
}
