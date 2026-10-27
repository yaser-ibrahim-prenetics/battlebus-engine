export interface PaymentTransaction {
  id: string;
  kind: string;
  status: string;
  gateway: string;
  paymentId?: string | null;
  order?: { id: string };
}
export interface GiftCardApplication {
  giftCardNumber: string;
  amount: string;
  currency: string;
}
export interface OrderAccounting {
  paymentId?: string;
  giftCardApplications: GiftCardApplication[];
  /** Only last four characters from issuance receipts; never redeemable codes. */
  purchasedGiftCards: Record<string, string>;
}
