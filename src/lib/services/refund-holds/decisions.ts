import { normalizeShopifyOrderIdFromLoopProvider } from "@/lib/helpers/loop-return-refund";
import type { ShopifyRefundCreatedEvent } from "@/inngest/events";
import { getDatabasePool } from "@/lib/db/database";
import { insertDecisionSQL, readDecisionSQL } from "@/lib/sql/refund-holds/decisions";
import { refundHoldPolicy } from "./policy";

export async function getRefundHoldDecision(data: ShopifyRefundCreatedEvent["data"]) {
  const shop = data.shopifyStore?.trim().toLowerCase();
  const source = data.refundInitiator ?? "shopify_webhook";
  const refundId = String(data.refundId ?? "");
  const orderId = String(data.refundJson.order_id ?? "");
  if (!shop || !refundId || !orderId)
    throw new Error("Refund hold requires store, refund and order IDs");
  // Loop return IDs are not Shopify refund IDs. Keep their separate namespace.
  if (source === "shopify_webhook" && String(data.refundJson.id) !== refundId) {
    throw new Error("Refund payload ID does not match event");
  }
  const eventOrderId = normalizeShopifyOrderIdFromLoopProvider(String(data.shopifyOrderId));
  if (eventOrderId !== orderId) throw new Error("Refund payload order ID does not match event");
  const policy = refundHoldPolicy(data.refundJson);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Refund hold database is required before processing refunds");
  await pool.query(insertDecisionSQL, [
    shop,
    source,
    refundId,
    orderId,
    policy.unfulfilledLineCount,
    policy.raisedAt,
    policy.timestampSource,
  ]);
  const { rows } = await pool.query<{
    order_id: string;
    unfulfilled_line_count: number;
    hold_until: Date | null;
    waiting: boolean;
  }>(readDecisionSQL, [shop, source, refundId]);
  const row = rows[0];
  if (!row || row.order_id !== orderId) throw new Error("Refund hold order identity conflict");
  return {
    holdUntil: row.hold_until?.toISOString() ?? null,
    waiting: row.waiting,
    unfulfilledLineCount: row.unfulfilled_line_count,
  };
}
