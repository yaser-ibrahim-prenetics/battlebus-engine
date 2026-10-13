import { getOrder, getOrderTransactions } from "@/lib/clients/shopify";
import {
  getGiftCardApplications,
  getGiftCardMaskedCodes,
  getGiftCardPurchases,
  getPurchasePaymentReference,
} from "@/lib/helpers/payment-accounting";
import type { StepTools } from "./types";

export type OrderPaymentAccounting = {
  paymentReference: string;
  giftCardApplications: ReturnType<typeof getGiftCardApplications>;
  giftCardPurchases: ReturnType<typeof getGiftCardPurchases>;
  giftCardCodes: Record<string, string>;
};

export const EMPTY_PAYMENT_ACCOUNTING: OrderPaymentAccounting = {
  paymentReference: "",
  giftCardApplications: [],
  giftCardPurchases: [],
  giftCardCodes: {},
};

export async function loadOrderPaymentAccounting({
  step,
  shopifyOrderId,
  shopifyOrderName,
  shopifyStore,
}: {
  step: StepTools;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyStore?: string | null;
}): Promise<OrderPaymentAccounting> {
  return step.run("shopify-payment-accounting", async () => {
    const [freshOrder, transactions] = await Promise.all([
      getOrder(shopifyOrderId, shopifyStore),
      getOrderTransactions(shopifyOrderId, shopifyStore),
    ]);
    const giftCardCodes = getGiftCardMaskedCodes(
      Array.isArray(freshOrder.fulfillments) ? freshOrder.fulfillments : [],
      Array.isArray(freshOrder.line_items) ? freshOrder.line_items : []
    );
    if (giftCardCodes === null) {
      throw new Error(
        `[Shopify] Gift-card purchase for ${shopifyOrderName} does not have an issued masked code yet`
      );
    }
    return {
      paymentReference: getPurchasePaymentReference(transactions),
      giftCardApplications: getGiftCardApplications(transactions),
      giftCardPurchases: getGiftCardPurchases(freshOrder.line_items || [], giftCardCodes),
      giftCardCodes,
    };
  });
}
