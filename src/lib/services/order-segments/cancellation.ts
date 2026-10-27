import { config } from "@/lib/config";
import * as gps from "@/lib/clients/gps";
import { readPlan, saveProgress } from "./store";
import { executeFulfillmentAction } from "../fulfillment-actions/ledger";
import type { StepRunner } from "./types";

export async function cancelOrderSegments(shop: string, orderId: string, step: StepRunner) {
  if (config.features.dryRunMode || !config.features.enableGpsSync) return null;
  const stored = await readPlan(shop, orderId);
  if (!stored) return null;
  for (const segment of stored.plan.segments) {
    if (segment.warehouse !== "GPS Warehouse" && segment.warehouse !== "GPS UK Warehouse") continue;
    await step.run(`cancel-gps-segment-${segment.index}`, async () => {
      const progress = (await readPlan(shop, orderId))?.progress[String(segment.index)];
      if (progress?.cancelled) return;
      if (!progress?.gpsOrderId)
        throw new Error(
          `GPS segment ${segment.index} has no confirmed order ID; reconcile before cancelling`
        );
      const warehouse = segment.warehouse as "GPS Warehouse" | "GPS UK Warehouse";
      await executeFulfillmentAction(
        {
          provider: "gps",
          scope: `${shop}:${warehouse}:cancellation`,
          sourceOrderId: orderId,
          sourceLineIds: [`segment:${segment.index}`],
          action: `cancel:${segment.index}`,
        },
        { gpsOrderId: progress.gpsOrderId },
        async () => {
          const result = await gps.cancelOutboundOrder(progress.gpsOrderId!, warehouse);
          if (!result.success) throw new Error("GPS cancellation was not confirmed");
          return { cancelled: true };
        }
      );
      await saveProgress(shop, orderId, segment.index, { cancelled: true });
    });
  }
  return { status: "cancelled", reason: "All GPS segments cancelled" };
}
