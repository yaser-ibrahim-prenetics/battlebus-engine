import { withSegmentPublication } from "./publication";
import * as hub from "@/lib/clients/cs-platform";
import { readAllocationsSQL } from "@/lib/sql/order-segments/fulfillments";
import { readPlanSQL, updateProgressSQL } from "@/lib/sql/order-segments/plans";
import type { Allocation } from "./allocation";
import type { StoredPlan } from "./types";

/** Serialize snapshots through publication, so an older event cannot publish last. */
export async function publishSegmentCompletion(shop: string, orderId: string) {
  return withSegmentPublication(shop, orderId, async (client) => {
    const { rows } = await client.query<Allocation>(readAllocationsSQL, [shop, orderId]);
    const stored = (await client.query<StoredPlan>(readPlanSQL, [shop, orderId])).rows[0];
    if (!stored) throw new Error("Segment plan missing after fulfillment");
    const segments = [];
    for (const segment of stored.plan.segments) {
      const progress = stored.progress[String(segment.index)];
      const physical = progress?.lines?.filter((line) => !line.isService) || [];
      const fulfilled =
        progress?.fulfilled === true ||
        (physical.length > 0 &&
          physical.every(
            (line) =>
              rows
                .filter((row) => row.completed && row.segment_index === segment.index)
                .reduce((sum, row) => sum + (row.quantities[line.sourceLineId] || 0), 0) >=
              line.sourceQuantity
          ));
      if (fulfilled)
        await client.query(updateProgressSQL, [
          shop,
          orderId,
          String(segment.index),
          JSON.stringify({ fulfilled: true }),
        ]);
      segments.push({ ...segment, ...progress, fulfilled });
    }
    await hub.sendOrderUpdate({
      id: orderId,
      d365FulfillmentStatus: segments.every((segment) => segment.fulfilled) ? "synced" : "pending",
      state: { orderSegments: segments },
    });
  });
}
