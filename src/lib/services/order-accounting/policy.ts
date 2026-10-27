import type { ShopifyOrderPayload, ShopifyTransaction } from "@/inngest/events";
import type { OrderAccounting, PaymentTransaction } from "./types";

export function resolvePaymentReference(transactions: PaymentTransaction[]): string | undefined {
  const payments = transactions.filter(
    (t) =>
      t.status.toUpperCase() === "SUCCESS" &&
      ["CAPTURE", "SALE"].includes(t.kind.toUpperCase()) &&
      t.gateway !== "gift_card"
  );
  // Prefer an actual processor payment ID over the Spock order-ID fallback.
  const withReference = payments.find((t) => t.paymentId?.trim());
  if (withReference) return withReference.paymentId!.trim();
  return payments[0]?.order?.id.split("/").pop() || undefined;
}

export function resolveGiftCardApplications(transactions: ShopifyTransaction[]) {
  const seen = new Set<string>();
  return transactions
    .filter(
      (t) =>
        t.gateway === "gift_card" && t.status === "success" && ["capture", "sale"].includes(t.kind)
    )
    .flatMap((t) => {
      if (seen.has(String(t.id))) return [];
      seen.add(String(t.id));
      const lastCharacters = t.receipt?.gift_card_last_characters;
      if (
        !lastCharacters ||
        !t.currency ||
        !Number.isFinite(Number(t.amount)) ||
        Number(t.amount) < 0
      ) {
        throw new Error("Successful gift-card payment is missing accounting receipt information");
      }
      return [
        {
          giftCardNumber: String(lastCharacters).slice(-4),
          amount: t.amount,
          currency: t.currency,
        },
      ];
    });
}

export function resolvePurchasedGiftCards(order: ShopifyOrderPayload): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of order.line_items.filter((line) => line.gift_card)) {
    const receipt = (order.fulfillments ?? [])
      .flatMap((f) => f.receipt?.gift_cards ?? [])
      .find((card) => String(card.line_item_id) === String(line.id) && card.masked_code);
    if (!receipt?.masked_code)
      throw new Error(`Gift-card issuance receipt is not ready for line ${line.id}`);
    result[String(line.id)] = receipt.masked_code.slice(-4);
  }
  return result;
}

export function accountingComment(order: ShopifyOrderPayload, accounting: OrderAccounting): string {
  return [
    ...accounting.giftCardApplications.map(
      (card) => `Gift Card: ${card.giftCardNumber} - ${card.amount} ${card.currency}`
    ),
    ...order.line_items
      .filter((line) => line.gift_card)
      .map((line) => {
        const code = accounting.purchasedGiftCards[String(line.id)];
        if (!code) throw new Error(`Missing gift-card receipt for line ${line.id}`);
        return `Gift Card Purchase: ${code} - ${Number(line.price).toFixed(2)} x ${line.quantity}`;
      }),
  ].join("\n");
}
