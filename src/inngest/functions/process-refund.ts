import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import type { ShopifyRefundPayload } from "../events";
import {
  THROTTLE_CONFIGS,
  CONCURRENCY_CONFIGS,
  RATE_LIMIT_CONFIGS,
  RETRY_CONFIGS,
} from "./utils/constants";

export const processRefund = inngest.createFunction(
  {
    id: "process-shopify-refund",
    name: "Process Shopify Refund",
    idempotency: "event.data.refundId",
    retries: RETRY_CONFIGS.DEFAULT,
    throttle: {
      ...THROTTLE_CONFIGS.REFUND,
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        ...CONCURRENCY_CONFIGS.REFUND,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      ...RATE_LIMIT_CONFIGS.REFUND,
      key: "event.data.shopifyOrderId",
    },
  },
  { event: "shopify/refund.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, refundId, refundJson } = event.data;
    const refund = refundJson as ShopifyRefundPayload;

    if (config.features.dryRunMode) {
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order && config.features.enableDynamicsSync) {
      return {
        status: "no_d365_order",
        refundId,
        shopifyOrderId,
        message: "D365 order not found - refund cannot be processed",
      };
    }

    const refundAmount = await step.run("calculate-refund-amount", async () => {
      const totalAmount = refund.transactions
        ?.filter((tx) => tx.kind === "refund" && tx.status === "success")
        .reduce((sum, tx) => sum + parseFloat(tx.amount || "0"), 0) || 0;

      return totalAmount;
    });

    const creditNote = await step.run("create-d365-credit-note", async () => {
      if (!config.features.enableDynamicsSync || !d365Order) {
        return { CreditNoteNumber: `SKIP-${refundId}`, status: "skipped" };
      }

      const dataAreaId = d365Order.dataAreaId || config.dynamics.dataAreaId;
      const refundLines = refund.refund_line_items?.map((line) => ({
        itemNumber: line.line_item.sku,
        quantity: line.quantity,
        refundAmount: parseFloat(line.subtotal || "0") + parseFloat(line.total_tax || "0"),
      })) || [];

      // TODO: Implement D365 credit note creation via THK API
      return {
        CreditNoteNumber: `CN-${refundId}`,
        status: "not_implemented",
        dataAreaId,
        originalSalesOrderNumber: d365Order.SalesOrderNumber,
        refundAmount,
        refundLines,
      };
    });

    return {
      status: creditNote.status === "not_implemented" ? "partial" : "success",
      refundId,
      shopifyOrderId,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      creditNoteNumber: creditNote.CreditNoteNumber,
      refundAmount,
      processedAt: new Date().toISOString(),
    };
  }
);
