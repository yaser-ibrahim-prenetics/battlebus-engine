import type { OrderAccounting } from "../../order-accounting/types";
import type { ShopifyRefundPayload } from "@/inngest/events";
import { getDatabasePool } from "@/lib/db/database";
import { lockRefundsSQL, readRefundsSQL, reserveRefundSQL } from "@/lib/sql/order-segments/refunds";
import { fingerprint } from "../../fulfillment-actions/identity";
import type { StoredPlan } from "../types";
import {
  allocateSegmentRefund,
  type RefundOrder,
  type SegmentRefundAllocation,
} from "./allocation";
interface Reservation {
  refund_id: string;
  request_hash: string;
  allocations: SegmentRefundAllocation[];
  completed: boolean;
}
export async function reserveSegmentRefund(
  shop: string,
  stored: StoredPlan,
  order: RefundOrder,
  refund: ShopifyRefundPayload,
  amountCents: number,
  accounting?: OrderAccounting
) {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Refund allocation requires the database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(lockRefundsSQL, [JSON.stringify([shop, stored.plan.orderId, "refunds"])]);
    const { rows } = await client.query<Reservation>(readRefundsSQL, [shop, stored.plan.orderId]);
    const hash = fingerprint({ refund, amountCents, plan: stored.plan });
    const existing = rows.find((row) => row.refund_id === String(refund.id));
    if (existing && existing.request_hash !== hash)
      throw new Error("Refund changed after reservation");
    const result = existing ?? {
      refund_id: String(refund.id),
      request_hash: hash,
      allocations: allocateSegmentRefund(
        stored,
        order,
        refund,
        amountCents,
        rows.flatMap((row) => row.allocations),
        accounting
      ),
      completed: false,
    };
    if (!existing)
      await client.query(reserveRefundSQL, [
        shop,
        stored.plan.orderId,
        String(refund.id),
        hash,
        JSON.stringify(result.allocations),
      ]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
