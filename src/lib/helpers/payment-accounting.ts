import type {
  ShopifyFulfillment,
  ShopifyLineItem,
  ShopifyTransaction,
} from "@/inngest/events";

export interface GiftCardApplication {
  giftCardNumber: string;
  amount: string;
  currency: string;
}

export interface GiftCardPurchase {
  giftCardNumber: string;
  price: string;
  quantity: number;
}

export function getPurchasePaymentReference(transactions: ShopifyTransaction[]): string {
  if (transactions.length === 0) return "";

  const paymentReference = transactions.reduce((reference, transaction) => {
    if (
      ["capture", "sale"].includes(String(transaction.kind).toLowerCase()) &&
      String(transaction.gateway).toLowerCase() !== "gift_card"
    ) {
      return (
        transaction.receipt?.metadata?.order_id ||
        transaction.payment_id ||
        reference
      );
    }
    return reference;
  }, "");

  if (!paymentReference) {
    throw new Error("No non-gift Shopify purchase payment reference found");
  }
  return paymentReference;
}

export function getGiftCardApplications(
  transactions: ShopifyTransaction[]
): GiftCardApplication[] {
  const seen = new Set<string>();
  const applications: GiftCardApplication[] = [];

  for (const transaction of transactions) {
    if (
      String(transaction.gateway).toLowerCase() !== "gift_card" ||
      !["capture", "sale"].includes(String(transaction.kind).toLowerCase())
    ) {
      continue;
    }
    const giftCardNumber = String(
      transaction.receipt?.gift_card_last_characters || ""
    ).trim();
    if (!giftCardNumber) continue;
    const application = {
      giftCardNumber,
      amount: String(transaction.amount || "0"),
      currency: String(transaction.currency || ""),
    };
    const key = `${application.giftCardNumber}:${application.amount}:${application.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    applications.push(application);
  }

  return applications;
}

export function getGiftCardMaskedCodes(
  fulfillments: ShopifyFulfillment[],
  lineItems: ShopifyLineItem[]
): Record<string, string> | null {
  const codes: Record<string, string> = {};
  for (const item of lineItems.filter((line) => line.gift_card)) {
    for (const fulfillment of fulfillments) {
      const code = fulfillment.receipt?.gift_cards
        ?.find((giftCard) => String(giftCard.line_item_id) === String(item.id))
        ?.masked_code?.slice(-4);
      if (code) {
        codes[String(item.id)] = code;
        break;
      }
    }
    if (!codes[String(item.id)]) return null;
  }
  return codes;
}

export function getGiftCardPurchases(
  lineItems: ShopifyLineItem[],
  giftCardCodes: Record<string, string>
): GiftCardPurchase[] {
  return lineItems
    .filter((item) => item.gift_card)
    .map((item) => ({
      giftCardNumber: giftCardCodes[String(item.id)],
      price: (Number(item.price) || 0).toFixed(2),
      quantity: item.quantity,
    }))
    .filter((purchase) => Boolean(purchase.giftCardNumber));
}
