import { loadOrderAccounting } from "../../order-accounting/load";
import { refundProjectionOrder, requiresRefundAccounting } from "./allocation";
import { saveRefundOrderLine } from "../../order-lines";
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
  shopDomain: string,
  step: Pick<GetStepTools<typeof inngest>, "run">
) {
  if (config.features.dryRunMode || !config.features.enableDynamicsSync) return null;
  const shop = resolveShopifyAdminCredentials(shopDomain).shopDomain;
  const stored = await step.run("read-refund-segment-plan", () => readPlan(shop, String(order.id)));
  if (!stored) return null;
  const reservation = await step.run("reserve-segment-refund", async () => {
    const resolution = resolveRefundAmountUsd({
      refundAmount: analyzeRefundAmount(refund).amount,
      shopifyOrder: order,
      refund,
    });
    if (
      resolution.conversionApplied &&
      (!resolution.exchangeRateInfo || resolution.exchangeRateInfo.source === "fallback")
    )
      throw new Error("Refund requires a verified currency conversion");
    const amount = Math.round(resolution.refundAmountUsd * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid refund amount");
    const needsAccounting = requiresRefundAccounting(stored, order);
    const accounting = needsAccounting
      ? await loadOrderAccounting(refundProjectionOrder(order), shop)
      : undefined;
    return {
      ...(await reserveSegmentRefund(shop, stored, order, refund, amount, accounting)),
      conversion: resolution.exchangeRateInfo,
    };
  });
  const date = fulfillmentPostingDate(refund.created_at);
  if (!reservation.completed) {
    const outcomes = await Promise.allSettled(
      reservation.allocations.map(async (allocation) => {
        const segment = stored.plan.segments.find(
          (segment) => segment.index === allocation.segmentIndex
        )!;
        const salesOrderNumber = await step.run(
          `refund-${refund.id}-segment-${segment.index}-ready`,
          async () => {
            const current = await readPlan(shop, String(order.id));
            const progress = current?.progress[String(segment.index)];
            if (!progress?.completed || !progress.salesOrderNumber)
              throw new Error("Refund awaits completion of its target segment provider order");
            return progress.salesOrderNumber;
          }
        );
        if (!allocation.amountCents) {
          await step.run(`refund-${refund.id}-segment-${segment.index}-zero-amount`, async () => ({
            status: "no_financial_posting",
            salesOrderNumber,
            segmentIndex: segment.index,
            quantities: allocation.quantities,
          }));
          return;
        }
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
        const invoice = config.features.enableReturnInvoicePosting
          ? await step.run(`refund-${refund.id}-segment-${segment.index}-invoice`, () => {
              const request = {
                salesOrderNumber,
                dataAreaId: segment.dataAreaId,
                invoiceDate: date,
              };
              return executeFulfillmentAction(identity("invoice"), request, async () => {
                const result = await dynamics.postReturnOrderInvoice({
                  ...request,
                  invoiceDate: new Date(date),
                });
                if (result.skipped || !result.creditNoteNumber)
                  throw new Error("Refund credit note could not be verified");
                return result;
              });
            })
          : null;
        await step.run(`refund-${refund.id}-segment-${segment.index}-report`, async () => {
          const result = await saveRefundOrderLine({
            shopify_order_id: String(order.id),
            refund_id: String(refund.id),
            segment_index: segment.index,
            refund_sku: itemNumber,
            d365_sales_order_number: salesOrderNumber,
            data_area_id: segment.dataAreaId,
            refund_amount_usd: allocation.amountCents / 100,
            dynamics_inventory_lot_id: lotId,
            is_fulfilled_to_dynamics: true,
            credit_note_number: invoice?.creditNoteNumber ?? null,
            source_currency: reservation.conversion?.from ?? order.currency,
            exchange_rate: reservation.conversion?.rate ?? null,
            exchange_rate_source: reservation.conversion?.source ?? null,
          });
          if (!result.ok || result.degraded)
            throw new Error("Segment refund reporting could not be persisted");
        });
      })
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
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
