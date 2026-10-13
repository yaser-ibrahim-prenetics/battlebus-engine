import { getOrderTransactions } from "@/lib/clients/shopify";
import {
  getGiftCardApplications,
  getGiftCardMaskedCodes,
  getGiftCardPurchases,
  getPurchasePaymentReference,
} from "@/lib/helpers/payment-accounting";
import type { ShopifyOrderPayload } from "../../events";
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
  order,
  shopifyOrderId,
  shopifyOrderName,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
}): Promise<OrderPaymentAccounting> {
  return step.run("shopify-payment-accounting", async () => {
    const transactions = await getOrderTransactions(shopifyOrderId);
    const giftCardCodes = getGiftCardMaskedCodes(
      Array.isArray(order.fulfillments) ? order.fulfillments : [],
      Array.isArray(order.line_items) ? order.line_items : []
    );
    if (giftCardCodes === null) {
      throw new Error(
        `[Shopify] Gift-card purchase for ${shopifyOrderName} does not have an issued masked code yet`
      );
    }
    return {
      paymentReference: getPurchasePaymentReference(transactions),
      giftCardApplications: getGiftCardApplications(transactions),
      giftCardPurchases: getGiftCardPurchases(order.line_items || [], giftCardCodes),
      giftCardCodes,
    };
  });
}
