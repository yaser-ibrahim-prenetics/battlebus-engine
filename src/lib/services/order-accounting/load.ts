import type { ShopifyOrderPayload } from "@/inngest/events";
import { getOrder, getOrderTransactions, shopifyAdminGraphql } from "@/lib/clients/shopify";
import {
  ORDER_ACCOUNTING_API_VERSION,
  orderTransactionsQuery,
} from "@/lib/graphql/order-accounting";
import {
  resolveGiftCardApplications,
  resolvePaymentReference,
  resolvePurchasedGiftCards,
} from "./policy";
import type { OrderAccounting, PaymentTransaction } from "./types";

export async function loadOrderAccounting(
  order: ShopifyOrderPayload,
  shopDomain?: string
): Promise<OrderAccounting> {
  // Issuance is asynchronous. Re-read receipts inside this retryable step rather
  // than repeatedly inspecting the memoized order snapshot from order preparation.
  const receiptOrder = order.line_items.some((line) => line.gift_card)
    ? ((await getOrder(String(order.id), shopDomain)) as unknown as ShopifyOrderPayload)
    : order;
  const purchasedGiftCards = resolvePurchasedGiftCards({
    ...order,
    fulfillments: receiptOrder.fulfillments,
  });
  const response = await shopifyAdminGraphql<{
    data?: { order?: { transactions: PaymentTransaction[] } };
  }>(
    orderTransactionsQuery,
    { orderId: `gid://shopify/Order/${order.id}` },
    { apiVersion: ORDER_ACCOUNTING_API_VERSION, shopDomain }
  );
  const transactions = response.data?.order?.transactions;
  if (!Array.isArray(transactions) || transactions.length >= 250) {
    throw new Error("Shopify payment transaction response is missing or truncated");
  }
  const expectedGiftPayments = transactions.filter(
    (t) =>
      t.gateway === "gift_card" &&
      t.status.toUpperCase() === "SUCCESS" &&
      ["CAPTURE", "SALE"].includes(t.kind.toUpperCase())
  );
  const hasGiftCard = expectedGiftPayments.length > 0;
  const giftCardApplications = hasGiftCard
    ? resolveGiftCardApplications(
        await getOrderTransactions(order.id, shopDomain, { inShopCurrency: true })
      )
    : [];
  if (hasGiftCard && giftCardApplications.length === 0) {
    throw new Error("Gift-card payment has no successful receipt yet");
  }
  if (giftCardApplications.length !== expectedGiftPayments.length)
    throw new Error("Gift-card receipt list is incomplete");
  const paymentId = resolvePaymentReference(transactions);
  const coveredByGiftCards = giftCardApplications
    .filter((card) => card.currency === order.currency)
    .reduce((sum, card) => sum + Number(card.amount), 0);
  if (
    order.financial_status === "paid" &&
    Number(order.total_price) > 0 &&
    !paymentId &&
    coveredByGiftCards + 0.005 < Number(order.total_price)
  )
    throw new Error("Paid order has no successful payment reference yet");
  return {
    paymentId,
    giftCardApplications,
    purchasedGiftCards,
  };
}
