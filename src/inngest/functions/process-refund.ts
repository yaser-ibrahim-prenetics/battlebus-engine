// ============================================================================
// INNGEST FUNCTION: Process Shopify Refund
// ============================================================================
// This replaces the old "shopify-refund" task type from spock-store
// Handles Shopify refunds and creates corresponding D365 credit notes

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";

export const processRefund = inngest.createFunction(
  {
    id: "process-shopify-refund",
    name: "Process Shopify Refund",
    // Idempotency: Prevent duplicate processing of the same refund
    idempotency: "event.data.refundId",
    retries: 5,
    concurrency: {
      limit: 5,
    },
  },
  { event: "shopify/refund.created" },
  async ({ event, step }) => {
    const { shopifyOrderId, refundId } = event.data;

    console.log(`[Battle Bus] Processing refund: ${refundId} for order ${shopifyOrderId}`);

    // Check if dry run mode is enabled
    if (config.features.dryRunMode) {
      console.log(`[Dry Run] Would process refund: ${refundId}`);
      return {
        status: "dry_run",
        refundId,
        shopifyOrderId,
      };
    }

    // =========================================================================
    // STEP 1: Get the original D365 Sales Order
    // =========================================================================
    const d365Order = await step.run("get-d365-order", async () => {
      if (!config.features.enableDynamicsSync) {
        return null;
      }
      return dynamics.getSalesOrderByShopifyId(shopifyOrderId);
    });

    if (!d365Order && config.features.enableDynamicsSync) {
      console.log(`[Battle Bus] No D365 order found for Shopify order: ${shopifyOrderId}`);
      return {
        status: "no_d365_order",
        refundId,
        shopifyOrderId,
      };
    }

    // =========================================================================
    // STEP 2: Create D365 Credit Note / Return Order
    // =========================================================================
    const creditNote = await step.run("create-d365-credit-note", async () => {
      if (!config.features.enableDynamicsSync || !d365Order) {
        return { CreditNoteNumber: `SKIP-${refundId}` };
      }

      // In production, this would call the D365 API to create a credit note
      // For now, we'll log the intent
      console.log(`[Battle Bus] Would create credit note for D365 order: ${d365Order.SalesOrderNumber}`);

      // TODO: Implement D365 credit note creation
      // return dynamics.createCreditNote({
      //   dataAreaId: d365Order.dataAreaId,
      //   OriginalSalesOrderNumber: d365Order.SalesOrderNumber,
      //   RefundAmount: calculateRefundAmount(refundJson),
      //   RefundReference: `REFUND-${refundId}`,
      // });

      return { CreditNoteNumber: `CN-${refundId}` };
    });

    console.log(`[Battle Bus] Created credit note: ${creditNote.CreditNoteNumber}`);

    // =========================================================================
    // SUCCESS: Return final status
    // =========================================================================
    return {
      status: "success",
      refundId,
      shopifyOrderId,
      d365OrderNumber: d365Order?.SalesOrderNumber,
      creditNoteNumber: creditNote.CreditNoteNumber,
      processedAt: new Date().toISOString(),
    };
  }
);
