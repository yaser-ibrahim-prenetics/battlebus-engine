import type { ShopifyOrderPayload } from "@/inngest/events";
import { getOrderTransactions, shopifyAdminGraphql } from "@/lib/clients/shopify";
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
  const purchasedGiftCards = resolvePurchasedGiftCards(order);
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
  const hasGiftCard =
    transactions.some((t) => t.gateway === "gift_card") ||
    order.payment_gateway_names?.includes("gift_card");
  const giftCardApplications = hasGiftCard
    ? resolveGiftCardApplications(await getOrderTransactions(order.id, shopDomain))
    : [];
  if (hasGiftCard && giftCardApplications.length === 0) {
    throw new Error("Gift-card payment has no successful receipt yet");
  }
  return {
    paymentId: resolvePaymentReference(transactions),
    giftCardApplications,
    purchasedGiftCards,
  };
}
