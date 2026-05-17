import { createHmac, timingSafeEqual } from "crypto";
import type { ShopifyRefundPayload } from "@/inngest/events";

/**
 * Body shape for Loop `return.closed` payloads we care about (spock-store `LoopReturn`).
 * https://developers.loopreturns.com/
 */
export type LoopReturnRefundWebhookBody = {
  id: string;
  topic: string;
  trigger: string;
  state?: string;
  provider_order_id: string;
  refund?: string;
  currency?: string;
  refunds?: Array<{ provider_refund_id?: number }>;
};

/**
 * Shopify REST `/orders/:id.json` requires the numeric resource id.
 * Loop sometimes sends `provider_order_id` as a GraphQL GID (`gid://shopify/Order/123`).
 */
export function normalizeShopifyOrderIdFromLoopProvider(providerOrderId: string): string {
  const s = String(providerOrderId ?? "").trim();
  if (!s) return "";
  const gid = /^gid:\/\/shopify\/Order\/(\d+)$/i.exec(s);
  if (gid?.[1]) return gid[1];
  if (/^\d+$/.test(s)) return s;
  return s;
}

/** HMAC-SHA256 (UTF-8 body) → Base64 digest, compared to `x-loop-signature`. */
export function verifyLoopWebhookSignature(
  rawBodyUtf8: string,
  webhookKey: string,
  signatureHeader: string
): boolean {
  const computed = createHmac("sha256", webhookKey).update(rawBodyUtf8, "utf8").digest("base64");
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(String(signatureHeader).trim()));
  } catch {
    return false;
  }
}

/** Spock-store `loop.isRefundRequired`: refund total must be strictly positive money. */
export function loopClosedReturnRefundIsPositive(loopOrder: Pick<LoopReturnRefundWebhookBody, "refund">): boolean {
  const n = Number.parseFloat(String(loopOrder.refund ?? "0"));
  return Number.isFinite(n) && n > 0;
}

/** Accept only `topic=return`, `trigger=return.closed`; refund amount checked separately. */
export function isLoopReturnClosedPayload(
  raw: Record<string, unknown>
): raw is LoopReturnRefundWebhookBody {
  const topic = typeof raw.topic === "string" ? raw.topic : "";
  const trigger = typeof raw.trigger === "string" ? raw.trigger : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  const providerOrder =
    typeof raw.provider_order_id === "string"
      ? raw.provider_order_id
      : typeof raw.provider_order_id === "number"
        ? String(raw.provider_order_id)
        : "";
  if (topic !== "return" || trigger !== "return.closed" || !id.trim() || !providerOrder.trim()) {
    return false;
  }
  return true;
}

/**
 * Build a REST-shaped refund payload from Loop return.closed (spock-store `processLoopRefundOnly` contract).
 * We forward this as `shopify/refund.created` with `refundInitiator: loop_return_closed`.
 */
export function buildSyntheticShopifyRefundFromLoopReturn(
  body: LoopReturnRefundWebhookBody
): ShopifyRefundPayload {
  const normalizedOrderId = normalizeShopifyOrderIdFromLoopProvider(body.provider_order_id);
  const orderIdNum = Number.parseInt(normalizedOrderId, 10);
  const digitsOnly = String(body.id).replace(/\D/g, "");
  const loopIdNum = Number.parseInt(digitsOnly, 10);
  const providerTx = body.refunds?.[0]?.provider_refund_id;
  const refundIdNum = Number.isFinite(loopIdNum)
    ? loopIdNum
    : typeof providerTx === "number" && Number.isFinite(providerTx)
      ? providerTx
      : Math.floor(Date.now() % 2_147_483_647);

  const transactionId =
    typeof providerTx === "number" && Number.isFinite(providerTx) ? providerTx : 0;

  return {
    id: refundIdNum,
    order_id: Number.isFinite(orderIdNum) ? orderIdNum : 0,
    created_at: new Date().toISOString(),
    refund_line_items: [],
    transactions: [
      {
        id: transactionId,
        kind: "refund",
        status: "success",
        gateway: "loop_returns",
        amount: String(Math.abs(Number.parseFloat(String(body.refund ?? "0")))),
        currency: body.currency || "USD",
        receipt: { balance_transaction: { exchange_rate: 1 } },
      },
    ],
  };
}