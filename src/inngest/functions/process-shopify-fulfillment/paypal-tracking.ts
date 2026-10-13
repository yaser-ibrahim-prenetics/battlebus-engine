import * as paypal from "@/lib/clients/paypal";
import * as shopifyClient from "@/lib/clients/shopify";
import * as slack from "@/lib/clients/slack";

export async function syncPayPalTracking(params: {
  step: any;
  shopifyOrderId: string | number;
  shopifyOrderName: string;
  fulfillmentResults: Array<{
    status: string;
    trackingNumber?: string;
    carrier?: string | null;
  }>;
}): Promise<unknown> {
  if (!paypal.isEnabled()) return null;

  return params.step.run("sync-paypal-tracking", async () => {
    try {
      const transactions = await shopifyClient.getOrderTransactions(params.shopifyOrderId);
      const paypalTransactions = transactions.filter(
        (transaction) =>
          transaction.gateway?.toLowerCase().includes("paypal") &&
          transaction.kind === "sale" &&
          transaction.status === "success"
      );
      if (paypalTransactions.length === 0) {
        return { status: "skipped", reason: "no PayPal transactions on this order" };
      }

      const fulfilledWithTracking = params.fulfillmentResults.filter(
        (result) => result.status === "success" && result.trackingNumber
      );
      if (fulfilledWithTracking.length === 0) {
        return { status: "skipped", reason: "no successful fulfillments with tracking" };
      }

      const trackers = paypalTransactions.flatMap((transaction) =>
        fulfilledWithTracking.map((fulfillment) => ({
          transactionId: String(transaction.id),
          trackingNumber: fulfillment.trackingNumber!,
          carrierName: fulfillment.carrier,
        }))
      );
      const response = await paypal.syncTrackingBatch(trackers);
      return {
        status: "synced",
        trackersSubmitted: trackers.length,
        trackersProcessed: response.tracker_identifiers?.length || 0,
        errors: response.errors?.length || 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PayPal] Tracking sync failed for ${params.shopifyOrderName}: ${message}`);
      await slack
        .sendWarningMessage(
          "system",
          `PayPal tracking sync failed for ${params.shopifyOrderName}: ${message}`
        )
        .catch((warningError) => {
          console.warn(
            "[Fulfillment] Non-critical operation failed:",
            warningError instanceof Error ? warningError.message : warningError
          );
        });
      return { status: "error", error: message };
    }
  });
}
