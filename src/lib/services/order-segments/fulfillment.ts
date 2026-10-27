import type { ShopifyFulfillment } from "@/inngest/events";
import { config } from "@/lib/config";
import { resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import * as hub from "@/lib/clients/cs-platform";
import { queryDatabase } from "@/lib/db/database";
import { completeAllocationSQL, readAllocationsSQL } from "@/lib/sql/order-segments/fulfillments";
import { getFulfilmentConfig } from "@/lib/helpers/warehouse";
import { fulfillmentPostingDate } from "@/lib/helpers/fulfillment-date";
import { isDepositFulfillmentOrder } from "@/lib/helpers/d365-thk-fulfilment";
import { readPlan, findGpsSegment, saveProgress } from "./store";
import { fulfillmentOrderIds } from "./shopify";
import { reserveAllocations, type Allocation } from "./allocation";
import type { StepRunner } from "./types";

export async function fulfillOrderSegments(input: {
  shopDomain?: string;
  gpsOrderId?: string;
  orderId: string;
  fulfillments: ShopifyFulfillment[];
  step: StepRunner;
}) {
  if (config.features.dryRunMode || !config.features.enableDynamicsSync) return null;
  const shop = resolveShopifyAdminCredentials(input.shopDomain).shopDomain;
  const stored = await readPlan(shop, input.orderId);
  if (!stored) return null;
  for (const fulfillment of input.fulfillments) {
    if (fulfillment.status && fulfillment.status !== "success") continue;
    const allocations = await input.step.run(`allocate-fulfillment-${fulfillment.id}`, async () => {
      const binding = input.gpsOrderId ? await findGpsSegment(shop, input.gpsOrderId) : null;
      if (
        input.gpsOrderId &&
        (!binding || binding.orderId !== input.orderId || !binding.progress.fulfillmentOrderId)
      )
        throw new Error("GPS shipment has no matching segment binding");
      const foIds = binding
        ? [binding.progress.fulfillmentOrderId!]
        : await fulfillmentOrderIds(shop, fulfillment.id);
      const quantities: Record<string, number> = {};
      for (const line of fulfillment.line_items)
        quantities[String(line.id)] = (quantities[String(line.id)] ?? 0) + line.quantity;
      const matching = stored.plan.segments.filter((segment) =>
        foIds.includes(stored.progress[String(segment.index)]?.fulfillmentOrderId || "")
      );
      const gpsProgress =
        matching.length === 1 ? stored.progress[String(matching[0].index)] : undefined;
      const physical = gpsProgress?.lines?.filter((line) => !line.isService) || [];
      const fullGpsShipment =
        gpsProgress?.gpsOrderId &&
        physical.length > 0 &&
        physical.every((line) => quantities[line.sourceLineId] === line.sourceQuantity) &&
        Object.keys(quantities).every((id) => physical.some((line) => line.sourceLineId === id));
      const identity = fullGpsShipment ? `gps:${gpsProgress!.gpsOrderId}` : String(fulfillment.id);
      return reserveAllocations(shop, stored, identity, foIds, quantities);
    });
    for (const allocation of allocations) {
      await input.step.run(
        `fulfill-segment-${allocation.segment_index}-${fulfillment.id}`,
        async () => {
          if (allocation.completed) return;
          const segment = stored.plan.segments[allocation.segment_index];
          const progress = stored.progress[String(segment.index)];
          if (!progress?.salesOrderNumber || !progress.lines?.length)
            throw new Error("Segment provider order is not ready for fulfillment");
          const dimensions = getFulfilmentConfig(segment.warehouse);
          const lines = progress.lines.flatMap((line) => {
            const shipped = allocation.quantities[line.sourceLineId] ?? 0;
            if (line.isService ? !allocation.include_services : !shipped) return [];
            return [
              {
                itemNumber: line.itemNumber,
                lotId: line.lotId,
                quantity: line.isService
                  ? line.quantity
                  : (line.quantity * shipped) / line.sourceQuantity,
                trackingNumber: fulfillment.tracking_number || "",
                ...dimensions,
              },
            ];
          });
          const result = await dynamics.createFulfilment({
            fulfillmentId: `shopify:${allocation.fulfillment_id}`,
            dataAreaId: segment.dataAreaId,
            salesOrderNumber: progress.salesOrderNumber,
            type: "shipment",
            confirmedShippedDate: fulfillmentPostingDate(fulfillment.created_at),
            lines,
          });
          const deposit = await dynamics.verifyDepositFulfillmentApplied(
            progress.salesOrderNumber,
            segment.dataAreaId
          );
          if (
            isDepositFulfillmentOrder({
              depositFulfillment: deposit.depositFulfillment,
              processingStatus: deposit.processingStatus,
            })
          )
            await dynamics.assertDepositShipmentInvoicingComplete(
              progress.salesOrderNumber,
              segment.dataAreaId,
              result.response,
              { depositFulfillment: true }
            );
          await queryDatabase(completeAllocationSQL, [
            shop,
            input.orderId,
            allocation.fulfillment_id,
            segment.index,
          ]);
        }
      );
    }
  }
  await input.step.run("publish-segment-fulfillment", async () => {
    const { rows } = await queryDatabase<Allocation>(readAllocationsSQL, [shop, input.orderId]);
    const current = await readPlan(shop, input.orderId);
    if (!current) throw new Error("Segment plan missing after fulfillment");
    const segments = [];
    for (const segment of current.plan.segments) {
      const progress = current.progress[String(segment.index)];
      const physical = progress?.lines?.filter((line) => !line.isService) || [];
      const fulfilled =
        physical.length > 0 &&
        physical.every(
          (line) =>
            rows
              .filter((row) => row.completed && row.segment_index === segment.index)
              .reduce((sum, row) => sum + (row.quantities[line.sourceLineId] || 0), 0) >=
            line.sourceQuantity
        );
      await saveProgress(shop, input.orderId, segment.index, { fulfilled });
      segments.push({ ...segment, ...progress, fulfilled });
    }
    await hub.sendOrderUpdate({
      id: input.orderId,
      d365FulfillmentStatus: segments.every((segment) => segment.fulfilled) ? "synced" : "pending",
      state: { orderSegments: segments },
    });
  });
  return { status: "segments_fulfilled" };
}
