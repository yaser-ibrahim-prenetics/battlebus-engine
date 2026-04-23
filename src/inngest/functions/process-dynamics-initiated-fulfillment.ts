// ============================================================================
// DYNAMICS-INITIATED FULFILLMENT → SHOPIFY
// ============================================================================
// Mirrors spock-store POST /v1.0/dynamics/fulfilment/notification: when D365
// is the WMS source of truth, it notifies us and we create fulfillments
// in Shopify. Does NOT re-post packing slips in D365 (D365 is already updated).
// shopify/order.fulfilled is skipped in process-shopify-fulfillment when the
// fulfillment note contains "FulfillmentType: dynamics_initiated".
//
// Flow: Dynamics 365 → Battle Bus (webhook) → Inngest → Shopify fulfillments.json

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";
import { mapShopifySkuToDynamics } from "@/lib/transformers/sku";
import { getTrackingUrl, mapGpsCarrierToShopify } from "@/lib/helpers/tracking";
import { CONCURRENCY_CONFIGS, THROTTLE_CONFIGS, RETRY_CONFIGS } from "@/lib/utils/constants";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";
import type { DynamicsFulfilmentNotificationPayload } from "@/lib/types/dynamics-fulfilment";
import type { ILineItem } from "@/lib/types/shopify";

function resolveShopifyOrderId(shopifyRef: string): { kind: "id"; id: number } | { kind: "name"; name: string } {
  const t = String(shopifyRef || "").trim();
  const n = parseInt(t, 10);
  if (t && String(n) === t && n > 0) return { kind: "id", id: n };
  return { kind: "name", name: t };
}

function trackingCompanyForDynamicsLine(ModeOfDelivery: string | null | undefined): string {
  const m = (ModeOfDelivery || "").trim();
  if (!m) return "Other";
  return mapGpsCarrierToShopify(m) || m;
}

export const processDynamicsInitiatedFulfillment = inngest.createFunction(
  {
    id: "process-dynamics-initiated-fulfillment",
    name: "Dynamics notification → Shopify fulfillment",
    idempotency: "event.data.salesOrderNumber + '-' + event.id",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.DYNAMICS,
      key: "event.data.salesOrderNumber",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.FULFILLMENT,
        key: "event.data.salesOrderNumber",
      },
    ],
    triggers: [{ event: "dynamics/fulfillment.notify" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const _runId = String(runId ?? "");
    const data = event.data as DynamicsFulfilmentNotificationPayload & { receivedAt?: string };
    const { type, salesOrderNumber, dataAreaId, lines, customerAccount } = data;
    const _flowStart = Date.now();

    logFlowEvent({
      flow: "dynamics_shopify_fulfill",
      step: "start",
      status: "started",
      runId: _runId || undefined,
      payload: { type, salesOrderNumber, dataAreaId, lineCount: lines?.length, customerAccount },
    });

    if (config.features.dryRunMode) {
      return await step.run("dry-run", async () => ({
        status: "dry_run",
        salesOrderNumber,
        dataAreaId,
      }));
    }

    if (type === "return") {
      logFlowEvent({
        flow: "dynamics_shopify_fulfill",
        step: "done",
        status: "completed",
        runId: _runId || undefined,
        payload: { skipped: "return" },
        durationMs: Date.now() - _flowStart,
      });
      return { status: "skipped", reason: "return_not_implemented" };
    }

    if (type !== "shipment") {
      return { status: "skipped", reason: "unsupported_type" };
    }

    if (lines.some((l) => l.quantity < 0)) {
      return { status: "skipped", reason: "negative_quantity" };
    }

    const d365 = await step.run("get-d365-header", () =>
      dynamics.getSalesOrderByNumber(salesOrderNumber, dataAreaId)
    );
    if (!d365) {
      logFlowEvent({
        level: "error",
        flow: "dynamics_shopify_fulfill",
        step: "d365_lookup",
        status: "failed",
        runId: _runId || undefined,
        errorMessage: "Sales order not found in D365",
        payload: { salesOrderNumber, dataAreaId },
        durationMs: Date.now() - _flowStart,
      });
      throw new Error(`D365 sales order not found: ${salesOrderNumber} (${dataAreaId})`);
    }

    const shopifyRef = (d365.THK_ShopifyReference || "").trim();
    if (!shopifyRef) {
      throw new Error(`D365 order ${salesOrderNumber} has no THK_ShopifyReference — cannot resolve Shopify order`);
    }

    const shopifyOrder = await step.run("resolve-shopify-order", async () => {
      const r = resolveShopifyOrderId(shopifyRef);
      if (r.kind === "id") {
        return shopify.getOrder(r.id, null);
      }
      const found = await shopify.searchOrdersByName(r.name, null);
      if (!found || found.length === 0) {
        throw new Error(`Shopify order not found for reference ${shopifyRef}`);
      }
      return found[0];
    });

    const shopifyOrderId = shopifyOrder.id;
    const shopifyOrderName = shopifyOrder.name;

    const result = await step.run("fulfill-in-shopify", async () => {
      const fulfillmentOrders = await shopify.getFulfillmentOrders(shopifyOrderId);
      const openFo = fulfillmentOrders.find(
        (fo) => fo.status === "open" || fo.status === "in_progress"
      );
      if (!openFo) {
        return { status: "no_open_fulfillment_order" as const };
      }

      const remaining = new Map<string, number>();
      for (const l of lines) {
        if (l.quantity <= 0) continue;
        const key = String(l.itemNumber || "")
          .trim()
          .toUpperCase();
        if (!key) continue;
        remaining.set(key, (remaining.get(key) ?? 0) + l.quantity);
      }
      if (remaining.size === 0) {
        return { status: "no_lines" as const };
      }

      const lineItems: { id: number; quantity: number }[] = [];
      for (const li of openFo.line_items) {
        const orderLine = shopifyOrder.line_items.find((o: ILineItem) => o.id === li.line_item_id);
        if (!orderLine?.sku) continue;
        const dKey = mapShopifySkuToDynamics(String(orderLine.sku))
          .trim()
          .toUpperCase();
        const rem = remaining.get(dKey);
        if (rem === undefined || rem <= 0) continue;
        const q = Math.min(Number(li.fulfillable_quantity) || 0, rem);
        if (q <= 0) continue;
        lineItems.push({ id: li.id, quantity: q });
        remaining.set(dKey, rem - q);
      }

      if (lineItems.length === 0) {
        return { status: "no_matching_lines" as const, shopifyOrderId, shopifyOrderName };
      }

      const firstPhysical = lines.find((l) => l.quantity > 0);
      const trackingNumber = (firstPhysical?.trackingNumber || "").trim() || "Pending";
      const company = trackingCompanyForDynamicsLine(
        firstPhysical?.ModeOfDelivery as string | undefined
      );
      const url =
        trackingNumber && trackingNumber !== "Pending"
          ? getTrackingUrl(company, trackingNumber)
          : undefined;

      if (!config.features.enableShopifyFulfillmentWriteback) {
        return {
          status: "writeback_off" as const,
          shopifyOrderId,
          shopifyOrderName,
          wouldLineItems: lineItems,
        };
      }

      const fulfillment = await shopify.createFulfillment(
        openFo.id,
        { number: trackingNumber, company, url: url || undefined },
        lineItems,
        "dynamics_initiated"
      );
      return {
        status: "fulfilled" as const,
        shopifyOrderId,
        shopifyOrderName,
        shopifyFulfillmentId: String(fulfillment.id),
        lineItemCount: lineItems.length,
      };
    });

    logFlowEvent({
      flow: "dynamics_shopify_fulfill",
      step: "done",
      status: (result as { status?: string }).status === "fulfilled" ? "completed" : "completed",
      runId: _runId || undefined,
      shopifyOrderName,
      shopifyOrderId: String(shopifyOrderId),
      payload: result,
      durationMs: Date.now() - _flowStart,
    });

    return {
      status: "success",
      salesOrderNumber,
      dataAreaId,
      shopifyOrderId: String(shopifyOrderId),
      shopifyOrderName,
      result,
    };
  }
);
