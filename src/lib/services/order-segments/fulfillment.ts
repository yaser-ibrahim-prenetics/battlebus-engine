import type { ShopifyFulfillment } from "@/inngest/events";
import { config } from "@/lib/config";
import { resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import { queryDatabase } from "@/lib/db/database";
import { completeAllocationSQL } from "@/lib/sql/order-segments/fulfillments";
import { getFulfilmentConfig } from "@/lib/helpers/warehouse";
import { fulfillmentPostingDate } from "@/lib/helpers/fulfillment-date";
import { isDepositFulfillmentOrder } from "@/lib/helpers/d365-thk-fulfilment";
import { readPlan, findGpsSegment } from "./store";
import { fulfillmentOrderIds } from "./shopify";
import { reserveAllocations } from "./allocation";
import type { StepRunner } from "./types";
import {
  InventoryUnavailableError,
  isInventoryUnavailableError,
} from "@/lib/services/oos-recovery/inventory-failure";

export async function fulfillOrderSegments(input: {
  shopDomain?: string;
  gpsOrderId?: string;
  orderId: string;
  fulfillments: ShopifyFulfillment[];
  step: StepRunner;
  beforeExternalMutation?: () => Promise<unknown>;
}) {
  if (config.features.dryRunMode || !config.features.enableDynamicsSync) return null;
  const shop = resolveShopifyAdminCredentials(input.shopDomain).shopDomain;
  const stored = await readPlan(shop, input.orderId);
  if (!stored) return null;
  const results = [];
  const physicalIds = new Set(
    stored.plan.segments.flatMap((segment) =>
      segment.lines.filter((line) => line.physical).map((line) => line.lineItemId)
    )
  );
  for (const fulfillment of input.fulfillments) {
    const physicalLines = fulfillment.line_items.filter((line) => physicalIds.has(String(line.id)));
    if (!physicalLines.length) continue;
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
      for (const line of physicalLines)
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
      return reserveAllocations(
        shop,
        stored,
        identity,
        foIds,
        quantities,
        fulfillmentPostingDate(fulfillment.created_at)
      );
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
                sourceLineId: line.sourceLineId,
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
          let result: Awaited<ReturnType<typeof dynamics.createFulfilment>>;
          try {
            await input.beforeExternalMutation?.();
            result = await dynamics.createFulfilment({
              fulfillmentId: `shopify:${allocation.fulfillment_id}`,
              dataAreaId: segment.dataAreaId,
              salesOrderNumber: progress.salesOrderNumber,
              type: "shipment",
              confirmedShippedDate: allocation.posting_date,
              lines,
            });
          } catch (error) {
            if (isInventoryUnavailableError(error) && error.blockedItems.length === 0) {
              throw new InventoryUnavailableError(
                error.provider,
                error.category,
                error.message,
                progress.lines.flatMap((line) => {
                  const shipped = allocation.quantities[line.sourceLineId] ?? 0;
                  if (line.isService || !shipped) return [];
                  return [
                    {
                      provider: "d365" as const,
                      warehouse: segment.dataAreaId.toUpperCase(),
                      sku: line.itemNumber.toUpperCase(),
                      orderLineId: line.sourceLineId,
                      quantityNeeded: Math.max(
                        1,
                        Math.ceil((line.quantity * shipped) / line.sourceQuantity)
                      ),
                    },
                  ];
                }),
                error.providerOrderNumber ?? progress.salesOrderNumber,
                error.providerWarehouse ?? segment.dataAreaId.toUpperCase()
              );
            }
            throw error;
          }
          const deposit = await dynamics.verifyDepositFulfillmentApplied(
            progress.salesOrderNumber,
            segment.dataAreaId
          );
          if (
            isDepositFulfillmentOrder({
              depositFulfillment: deposit.depositFulfillment,
              processingStatus: deposit.processingStatus,
            })
          ) {
            await input.beforeExternalMutation?.();
            await dynamics.assertDepositShipmentInvoicingComplete(
              progress.salesOrderNumber,
              segment.dataAreaId,
              result.response,
              { depositFulfillment: true }
            );
          }
          await queryDatabase(completeAllocationSQL, [
            shop,
            input.orderId,
            allocation.fulfillment_id,
            segment.index,
          ]);
        }
      );
    }
    results.push({
      fulfillmentId: fulfillment.id,
      status: "success",
      source: "Direct",
      trackingNumber: fulfillment.tracking_number,
      carrier: fulfillment.tracking_company,
    });
  }
  const primary = stored.progress["0"];
  return {
    status: "segments_fulfilled",
    results,
    d365Order: primary?.salesOrderNumber
      ? {
          SalesOrderNumber: primary.salesOrderNumber,
          dataAreaId: stored.plan.segments[0].dataAreaId,
        }
      : null,
  };
}
