import type { RefundOrder } from "./allocation";
import type { ShopifyRefundPayload } from "@/inngest/events";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import { resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import { queryDatabase } from "@/lib/db/database";
import { getWarehouseConfig, resolveRefundSkuAudit } from "@/lib/helpers/warehouse";
import { fulfillmentPostingDate } from "@/lib/helpers/fulfillment-date";
import { resolveRefundAmountUsd } from "@/lib/helpers/exchange";
import { analyzeRefundAmount } from "@/lib/utils/shopify-refund-amount";
import { completeRefundSQL } from "@/lib/sql/order-segments/refunds";
import { executeFulfillmentAction } from "../../fulfillment-actions/ledger";
import { readPlan } from "../store";
import type { GetStepTools } from "inngest";
import type { inngest } from "@/inngest/client";
import { reserveSegmentRefund } from "./store";

/** Called after the common refund hold and Loop deduplication checks. */
export async function refundOrderSegments(
  order: RefundOrder,
  refund: ShopifyRefundPayload,
  step: Pick<GetStepTools<typeof inngest>, "run">
) {
  if (config.features.dryRunMode || !config.features.enableDynamicsSync) return null;
  const shop = resolveShopifyAdminCredentials(undefined).shopDomain;
  const stored = await step.run("read-refund-segment-plan", () => readPlan(shop, String(order.id)));
  if (!stored) return null;
  if (stored.plan.segments.some((segment) => !stored.progress[String(segment.index)]?.completed))
    throw new Error("Refund awaits completion of every segment provider order");
  const reservation = await step.run("reserve-segment-refund", async () => {
    const resolution = resolveRefundAmountUsd({
      refundAmount: analyzeRefundAmount(refund).amount,
      shopifyOrder: order,
      refund,
    });
    if (resolution.conversionApplied && !resolution.exchangeRateInfo)
      throw new Error("Refund requires a verified currency conversion");
    const amount = Math.round(resolution.refundAmountUsd * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid refund amount");
    return reserveSegmentRefund(shop, stored, order, refund, amount);
  });
  const date = fulfillmentPostingDate(refund.created_at);
  if (!reservation.completed)
    for (const allocation of reservation.allocations) {
      if (!allocation.amountCents) continue;
      const segment = stored.plan.segments.find(
        (segment) => segment.index === allocation.segmentIndex
      )!;
      const salesOrderNumber = stored.progress[String(segment.index)].salesOrderNumber;
      if (!salesOrderNumber) throw new Error("Segment sales order binding missing");
      const itemNumber = resolveRefundSkuAudit(segment.warehouse, segment.dataAreaId).refundSku;
      const identity = (action: string) => ({
        provider: "dynamics" as const,
        scope: `${config.dynamics.baseUrl}:${segment.dataAreaId}:${shop}`,
        sourceOrderId: String(order.id),
        sourceLineIds: [`refund:${refund.id}:segment:${segment.index}`],
        action: `refund:${refund.id}:${action}`,
      });
      const lotId = await step.run(`refund-${refund.id}-segment-${segment.index}-line`, () => {
        const request = {
          salesOrderNumber,
          dataAreaId: segment.dataAreaId,
          itemNumber,
          quantity: -1,
          price: allocation.amountCents / 100,
        };
        return executeFulfillmentAction(identity("line"), request, async () => {
          const result = await dynamics.createSalesOrderLine(request);
          if (!result.InventoryLotId)
            throw new Error("Refund line response lacks inventory lot identity");
          return result.InventoryLotId;
        });
      });
      await step.run(`refund-${refund.id}-segment-${segment.index}-post`, async () => {
        const result = await dynamics.createFulfilment({
          fulfillmentId: `refund:${refund.id}:segment:${segment.index}`,
          salesOrderNumber,
          dataAreaId: segment.dataAreaId,
          type: "return",
          confirmedShippedDate: date,
          lines: [
            {
              itemNumber,
              quantity: -1,
              lotId,
              trackingNumber: "",
              ...getWarehouseConfig(segment.warehouse).return,
            },
          ],
        });
        if (result.response.status !== 1) throw new Error("Refund return posting is incomplete");
      });
      if (config.features.enableReturnInvoicePosting)
        await step.run(`refund-${refund.id}-segment-${segment.index}-invoice`, () => {
          const request = { salesOrderNumber, dataAreaId: segment.dataAreaId, invoiceDate: date };
          return executeFulfillmentAction(identity("invoice"), request, async () => {
            const result = await dynamics.postReturnOrderInvoice({
              ...request,
              invoiceDate: new Date(date),
            });
            if (result.skipped || !result.creditNoteNumber)
              throw new Error("Refund credit note could not be verified");
            return result;
          });
        });
    }
  await step.run("complete-segment-refund", async () => {
    const saved = await queryDatabase(completeRefundSQL, [
      shop,
      String(order.id),
      String(refund.id),
    ]);
    if (saved.rowCount !== 1) throw new Error("Refund completion could not be persisted");
  });
  return { status: "completed", refundId: String(refund.id), segments: reservation.allocations };
}
