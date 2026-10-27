import { getDatabasePool } from "@/lib/db/database";
import { fingerprint } from "../fulfillment-actions/identity";
import {
  lockAllocationsSQL,
  readAllocationsSQL,
  reserveAllocationSQL,
} from "@/lib/sql/order-segments/fulfillments";
import type { StoredPlan } from "./types";

export interface Allocation {
  fulfillment_id: string;
  segment_index: number;
  request_hash: string;
  posting_date: string;
  quantities: Record<string, number>;
  include_services: boolean;
  completed: boolean;
}

export function allocateQuantities(
  stored: StoredPlan,
  fulfillmentId: string,
  foIds: string[],
  quantities: Record<string, number>,
  previous: Allocation[],
  requestHash: string,
  postingDate: string
): Allocation[] {
  const replay = previous.filter((row) => row.fulfillment_id === fulfillmentId);
  if (replay.length) {
    if (replay.some((row) => row.request_hash !== requestHash))
      throw new Error("Fulfillment changed after allocation");
    return replay;
  }
  const result = new Map<number, Allocation>();
  for (const [lineId, quantity] of Object.entries(quantities)) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error("Invalid shipment quantity");
    const candidates = stored.plan.segments.flatMap((segment) => {
      if (!foIds.includes(stored.progress[String(segment.index)]?.fulfillmentOrderId || ""))
        return [];
      const line = segment.lines.find((line) => line.lineItemId === lineId);
      if (!line) return [];
      const used = previous
        .filter((row) => row.segment_index === segment.index)
        .reduce((sum, row) => sum + (row.quantities[lineId] ?? 0), 0);
      return line.quantity > used ? [{ segment, remaining: line.quantity - used }] : [];
    });
    const remaining = candidates.reduce((sum, item) => sum + item.remaining, 0);
    if (
      !candidates.length ||
      quantity > remaining ||
      (candidates.length > 1 && quantity !== remaining)
    )
      throw new Error(
        `Shipment quantity cannot be safely assigned to a segment for line ${lineId}`
      );
    for (const { segment, remaining: available } of candidates) {
      const allocation = result.get(segment.index) ?? {
        fulfillment_id: fulfillmentId,
        segment_index: segment.index,
        request_hash: requestHash,
        posting_date: postingDate,
        quantities: {},
        include_services: !previous.some(
          (row) => row.segment_index === segment.index && row.include_services
        ),
        completed: false,
      };
      allocation.quantities[lineId] = candidates.length === 1 ? quantity : available;
      result.set(segment.index, allocation);
    }
  }
  if (!result.size) throw new Error("No segment quantities in fulfillment");
  return [...result.values()];
}

export async function reserveAllocations(
  shop: string,
  stored: StoredPlan,
  fulfillmentId: string,
  foIds: string[],
  quantities: Record<string, number>,
  postingDate: string
) {
  const pool = await getDatabasePool();
  if (!pool) throw new Error("Database required for segment fulfillment");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(lockAllocationsSQL, [
      JSON.stringify([shop, stored.plan.orderId, "segment-fulfillment"]),
    ]);
    const { rows } = await client.query<Allocation>(readAllocationsSQL, [
      shop,
      stored.plan.orderId,
    ]);
    const hash = fingerprint({ foIds: [...foIds].sort(), quantities });
    const allocated = allocateQuantities(
      stored,
      fulfillmentId,
      foIds,
      quantities,
      rows,
      hash,
      postingDate
    );
    if (!rows.some((row) => row.fulfillment_id === fulfillmentId)) {
      for (const allocation of allocated)
        await client.query(reserveAllocationSQL, [
          shop,
          stored.plan.orderId,
          fulfillmentId,
          allocation.segment_index,
          hash,
          JSON.stringify(allocation.quantities),
          allocation.include_services,
          allocation.posting_date,
        ]);
    }
    await client.query("COMMIT");
    return allocated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
