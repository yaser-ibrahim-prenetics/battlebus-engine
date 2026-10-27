import { queryDatabase } from "@/lib/db/database";
import { readPlanSQL, reservePlanSQL, updateProgressSQL } from "@/lib/sql/order-segments/plans";
import { fingerprint } from "../fulfillment-actions/identity";
import type { SegmentPlan, SegmentProgress, StoredPlan } from "./types";

export async function readPlan(shop: string, orderId: string): Promise<StoredPlan | null> {
  const result = await queryDatabase<StoredPlan>(readPlanSQL, [shop, orderId]);
  return result.rows[0] ?? null;
}
export async function reservePlan(shop: string, plan: SegmentPlan): Promise<StoredPlan> {
  await queryDatabase(reservePlanSQL, [shop, plan.orderId, JSON.stringify(plan)]);
  const stored = await readPlan(shop, plan.orderId);
  if (!stored || fingerprint(stored.plan) !== fingerprint(plan))
    throw new Error("A different segment plan already exists; reconcile before retrying");
  return stored;
}
export async function saveProgress(
  shop: string,
  orderId: string,
  index: number,
  progress: SegmentProgress
) {
  const result = await queryDatabase(updateProgressSQL, [
    shop,
    orderId,
    String(index),
    JSON.stringify(progress),
  ]);
  if (result.rowCount !== 1) throw new Error("Segment plan missing while saving provider result");
}

export async function findGpsSegment(shop: string, gpsOrderId: string) {
  const { findGpsSegmentSQL } = await import("@/lib/sql/order-segments/plans");
  const result = await queryDatabase<StoredPlan & { shopify_order_id: string }>(findGpsSegmentSQL, [
    shop,
    gpsOrderId,
  ]);
  if (result.rows.length > 1) throw new Error("GPS order ID maps to multiple Shopify orders");
  const stored = result.rows[0];
  if (!stored) return null;
  const matches = stored.plan.segments.filter(
    (segment) => stored.progress[String(segment.index)]?.gpsOrderId === gpsOrderId
  );
  if (matches.length !== 1) throw new Error("GPS order ID maps to multiple segments");
  const segment = matches[0];
  return {
    orderId: stored.plan.orderId,
    segment,
    progress: stored.progress[String(segment.index)],
  };
}
