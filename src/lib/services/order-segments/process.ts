import type { ShopifyOrderPayload } from "@/inngest/events";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as gps from "@/lib/clients/gps";
import { reportSegmentProgress } from "./reporting";
import { getFulfillmentOrders, resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import { resolveSegmentRouting } from "./routing";
import { shouldSplitFulfillmentOrder, isDomesticOrder } from "@/lib/helpers/split";
import {
  calculateOrderCost,
  shouldSendToGps,
  toD365SalesOrderHeaderV3,
  toGpsOutboundOrder,
} from "@/lib/transformers/order";
import { executeFulfillmentAction } from "../fulfillment-actions/ledger";
import type { OrderAccounting } from "../order-accounting/types";
import { assertSegmentPlanReplayCompatible, planOrderSegments, segmentOrder } from "./planner";
import { readPlan, reservePlan, saveProgress } from "./store";
import { bindShopifySegments } from "./shopify";
import { segmentLineRequests } from "./lines";
import type { OrderSegment, StepRunner, SegmentProgress, RecordedSegmentLine } from "./types";
import { saveOrderLines } from "@/lib/services/order-lines";
import {
  buildProviderBlockedItems,
  InventoryUnavailableError,
  isInventoryUnavailableError,
} from "@/lib/services/oos-recovery/inventory-failure";

/** Returns null for legacy/unsplit orders; a stored plan always wins on replay. */
type ProcessSegmentsInput = {
  order: ShopifyOrderPayload;
  shopDomain?: string;
  step: StepRunner;
  accounting?: OrderAccounting;
  testMode?: boolean;
  fallbackDataArea: string;
  shortAddress?: string;
  ensureEligible?: () => Promise<unknown>;
  withExternalMutation?: <T>(
    operationKey: string,
    request: unknown,
    execute: () => Promise<T>,
    evidenceCodec?: { encode: (result: T) => unknown; decode: (evidence: unknown) => T }
  ) => Promise<T>;
  shouldReportFailure?: (error: unknown) => boolean;
};

export async function processOrderSegments(input: ProcessSegmentsInput) {
  try {
    return await runOrderSegments(input);
  } catch (error) {
    const shop = resolveShopifyAdminCredentials(input.shopDomain).shopDomain;
    if (input.shouldReportFailure?.(error) !== false) {
      try {
        await reportSegmentProgress(shop, input.order, error);
      } catch {
        console.error("[OrderSegments] Could not report recovery state");
      }
    }
    throw error;
  }
}

async function runOrderSegments(input: ProcessSegmentsInput) {
  if (config.features.dryRunMode || !config.features.enableDynamicsSync || input.testMode)
    return null;
  const { order, step, accounting } = input;
  const withExternalMutation = <T>(
    operationKey: string,
    request: unknown,
    execute: () => Promise<T>,
    evidenceCodec?: { encode: (result: T) => unknown; decode: (evidence: unknown) => T }
  ) =>
    input.withExternalMutation
      ? input.withExternalMutation(operationKey, request, execute, evidenceCodec)
      : execute();
  const stringEvidence = {
    encode: (value: string) => ({ value }),
    decode: (evidence: unknown): string => {
      const value = (evidence as { value?: unknown })?.value;
      if (typeof value !== "string" || !value.trim()) throw new Error("Invalid string evidence");
      return value;
    },
  };
  if (!accounting) throw new Error("Payment accounting is required before splitting orders");
  const shop = resolveShopifyAdminCredentials(input.shopDomain).shopDomain;
  const stored = await step.run("plan-order-segments", async () => {
    const existing = await readPlan(shop, String(order.id));
    if (existing) {
      assertSegmentPlanReplayCompatible(existing.plan, order);
      return existing;
    }
    // Never split an aggregate order already accepted by the old processing path.
    const legacy = await dynamics.getSalesOrderByShopifyId(
      order.name,
      input.fallbackDataArea,
      undefined,
      { shopifyNumericId: String(order.id) }
    );
    if (legacy) return null;
    const fos = await getFulfillmentOrders(order.id, shop);
    const country =
      order.shipping_address?.country_code || order.billing_address?.country_code || "US";
    const decision = shouldSplitFulfillmentOrder(
      Number(order.total_price),
      country,
      isDomesticOrder(country)
    );
    const routing: Record<string, Pick<OrderSegment, "warehouse" | "dataAreaId">> = {};
    for (const fo of fos.filter((fo) => ["open", "in_progress"].includes(fo.status))) {
      if (
        !fo.line_items.some((item) =>
          order.line_items.some(
            (line) =>
              String(line.id) === String(item.line_item_id) &&
              line.requires_shipping &&
              !line.gift_card
          )
        )
      )
        continue;
      const location = String(fo.assigned_location_id);
      routing[location] = await resolveSegmentRouting(order, fo, country);
    }
    const plan = planOrderSegments(
      order,
      fos,
      decision.shouldSplit ? decision.threshold : 0,
      routing
    );
    if (plan.segments.length < 2) return null;
    return reservePlan(shop, plan);
  });
  if (!stored) return null;
  const { plan } = stored;
  const bindings = await step.run("bind-shopify-segments", async () => {
    return withExternalMutation(
      "shopify-segments:bind",
      { planHash: plan.inputHash },
      () => bindShopifySegments(shop, plan),
      {
        encode: (binding) => binding,
        decode: (evidence) => {
          if (
            !evidence ||
            typeof evidence !== "object" ||
            Object.values(evidence).some((value) => typeof value !== "string")
          ) {
            throw new Error("Invalid Shopify segment binding evidence");
          }
          return evidence as Record<number, string>;
        },
      }
    );
  });
  const outcomes = await Promise.allSettled(
    plan.segments.map(async (segment): Promise<SegmentProgress> => {
      await input.ensureEligible?.();
      const prefix = `segment-${segment.index}`;
      const projected = segmentOrder(order, plan, segment.index);
      const action = <T>(
        phase: string,
        request: unknown,
        execute: () => Promise<T>,
        evidenceCodec?: { encode: (result: T) => unknown; decode: (evidence: unknown) => T }
      ) =>
        withExternalMutation(`${prefix}:${phase}`, request, () =>
          executeFulfillmentAction(
            {
              provider: "dynamics",
              scope: `${config.dynamics.baseUrl}:${segment.dataAreaId}:${shop}`,
              sourceOrderId: String(order.id),
              sourceLineIds: [`segment:${segment.index}:${phase}`],
              action: `${prefix}:${phase}`,
            },
            request,
            execute
          ), evidenceCodec
        );
      const salesOrderNumber = await step.run(`${prefix}-header`, async () => {
        const header = toD365SalesOrderHeaderV3(
          projected,
          segment.warehouse,
          segment.dataAreaId,
          accounting,
          input.shortAddress
        );
        header.comment = `${header.comment || ""}\nSplit ${segment.index + 1}/${plan.segments.length}; Shopify fulfillment order ${bindings[segment.index]}`;
        const result = await action("header", header, async () => {
          const result = await dynamics.createSalesOrderHeaderV3(header);
          if (!result.SalesOrderNumber)
            throw new Error("D365 header response missing sales order number");
          return result.SalesOrderNumber;
        }, stringEvidence);
        await saveProgress(shop, plan.orderId, segment.index, { salesOrderNumber: result });
        return result;
      });
      const requests = segmentLineRequests(projected, segment, salesOrderNumber, accounting);
      const recordedLines: RecordedSegmentLine[] = [];
      for (const [index, line] of requests.entries()) {
        const lotId = await step.run(`${prefix}-line-${index}`, () =>
          action(`line:${line.sourceLineId}:${line.request.itemNumber}`, line.request, async () => {
            const result = await dynamics.createSalesOrderLine(line.request);
            if (!result.InventoryLotId)
              throw new Error("D365 line response missing inventory lot ID");
            return result.InventoryLotId;
          }, stringEvidence)
        );
        recordedLines.push({
          sourceLineId: line.sourceLineId,
          sourceQuantity: line.sourceQuantity,
          itemNumber: line.request.itemNumber,
          quantity: line.request.quantity,
          lotId,
          isService: line.isService,
          isSubscriptionReward: line.isSubscriptionReward,
        });
      }
      await step.run(`${prefix}-save-lines`, () =>
        saveProgress(shop, plan.orderId, segment.index, {
          lines: recordedLines,
          postedAmountCents: Math.round(
            calculateOrderCost(requests.map((line) => line.request)) * 100
          ),
        })
      );
      await step.run(`${prefix}-save-reward-lines`, async () => {
        const rewards = recordedLines.filter((line) => line.isSubscriptionReward);
        if (!rewards.length) return { ok: true as const, upsertedRowCount: 0 };
        const saved = await saveOrderLines(
          rewards.map((line) => ({
            shopify_order_id: String(order.id),
            shopify_order_name: order.name,
            shopify_line_item_id: line.sourceLineId,
            shopify_sku: line.itemNumber,
            d365_item_number: line.itemNumber,
            d365_sales_order_number: salesOrderNumber,
            data_area_id: segment.dataAreaId,
            quantity: line.quantity,
            price: 0,
            dynamics_inventory_lot_id: line.lotId,
            is_service_line: false,
          }))
        );
        if (!saved.ok)
          throw new Error(`Could not persist segmented subscription rewards: ${saved.reason}`);
        return saved;
      });
      await step.run(`${prefix}-confirm`, () =>
        action("confirm", { salesOrderNumber }, async () => {
          await dynamics.confirmSalesOrder(salesOrderNumber, segment.dataAreaId);
          return { confirmed: true };
        })
      );
      if (calculateOrderCost(requests.map((line) => line.request)) > 0) {
        await step.run(`${prefix}-prepayment`, () =>
          action("prepayment", { salesOrderNumber }, async () => {
            await dynamics.createPrepayment(salesOrderNumber, segment.dataAreaId);
            return { posted: true };
          })
        );
      }
      const gpsOrderId = await step.run(`${prefix}-gps`, async () => {
        await input.ensureEligible?.();
        if (!config.features.enableGpsSync || !shouldSendToGps(projected, segment.warehouse))
          return undefined;
        const payload = toGpsOutboundOrder(
          projected,
          salesOrderNumber,
          segment.warehouse,
          input.shortAddress
        );
        payload.platformOrderNo =
          segment.index === 0 ? order.name : `${order.name}-${segment.index}`;
        if (!payload.productList.length) return undefined;
        let result: Awaited<ReturnType<typeof gps.createOutboundOrder>>;
        try {
          result = await withExternalMutation(`${prefix}:gps`, payload, () =>
            gps.createOutboundOrder(
              payload,
              segment.warehouse as "GPS Warehouse" | "GPS UK Warehouse"
            ),
            {
              encode: (value) => ({ orderNo: value.response.data?.[0]?.orderNo }),
              decode: (evidence) => {
                const orderNo = (evidence as { orderNo?: unknown })?.orderNo;
                if (typeof orderNo !== "string" || !orderNo.trim()) {
                  throw new Error("Invalid GPS order evidence");
                }
                return { response: { data: [{ orderNo }] } } as Awaited<
                  ReturnType<typeof gps.createOutboundOrder>
                >;
              },
            }
          );
        } catch (error) {
          if (isInventoryUnavailableError(error) && error.blockedItems.length === 0) {
            throw new InventoryUnavailableError(
              error.provider,
              error.category,
              error.message,
              buildProviderBlockedItems({
                order: projected,
                provider: error.provider,
                warehouse: error.providerWarehouse ?? segment.warehouse,
              }),
              error.providerOrderNumber,
              error.providerWarehouse ?? segment.warehouse
            );
          }
          throw error;
        }
        const id = result.response.data?.[0]?.orderNo;
        if (!id) throw new Error("GPS response missing segment order ID");
        await saveProgress(shop, plan.orderId, segment.index, { gpsOrderId: id });
        return id;
      });
      const result = { salesOrderNumber, gpsOrderId, completed: true };
      await step.run(`${prefix}-complete`, () =>
        saveProgress(shop, plan.orderId, segment.index, result)
      );
      return result;
    })
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  // Await every independent segment before surfacing an error; successful work is
  // durably checkpointed and reused when this workflow retries the failed segment.
  if (failure?.status === "rejected") throw failure.reason;
  const results = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : []
  );
  await step.run("publish-order-segments", () => reportSegmentProgress(shop, order));
  return { status: "segmented", segments: results };
}
