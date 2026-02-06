// ============================================================================
// IM8 BATTLE BUS - EVENT DEFINITIONS
// ============================================================================
// These events replace the old Task Table polling system.
// Each event triggers a durable Inngest function instead of creating a DB row.

export type ShopifyOrderCreatedEvent = {
  name: "shopify/order.created";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
  };
};

export type ShopifyRefundCreatedEvent = {
  name: "shopify/refund.created";
  data: {
    shopifyOrderId: string;
    refundId: string;
    shopifyStore: string;
    refundJson: ShopifyRefundPayload;
    receivedAt: string;
  };
};

export type ShopifyOrderCancelledEvent = {
  name: "shopify/order.cancelled";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    cancelledAt: string;
    cancelReason: string | null;
    receivedAt: string;
  };
};

export type ShopifyOrderPaidEvent = {
  name: "shopify/order.paid";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
  };
};

export type ShopifyOrderUpdatedEvent = {
  name: "shopify/order.updated";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
    // Track what changed for smarter processing
    changedFields?: string[];
  };
};

export type ShopifyOrderFulfilledEvent = {
  name: "shopify/order.fulfilled";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    fulfillments: ShopifyFulfillment[];
    receivedAt: string;
  };
};

export type GpsFulfilmentReceivedEvent = {
  name: "gps/fulfilment.received";
  data: {
    gpsOrderId: string;
    shopifyOrderId: string;
    trackingNumber: string;
    carrierCode: string;
    fulfilmentJson: GpsFulfilmentPayload;
    receivedAt: string;
  };
};

export type StordFulfilmentReceivedEvent = {
  name: "stord/fulfilment.received";
  data: {
    stordOrderId: string;
    shopifyOrderId: string;
    trackingNumber: string;
    carrierCode: string;
    fulfilmentJson: StordFulfilmentPayload;
    receivedAt: string;
  };
};

export type ExtensivOrderConfirmEvent = {
  name: "extensiv/order.confirm";
  data: {
    wmsEventId: string;
    extensivOrderId: string;
    shopifyOrderName: string;
    trackingNumber: string;
    carrier: string;
    dataAreaId: string;
    eventJson: ExtensivOrderConfirmPayload;
    receivedAt: string;
  };
};

export type ExtensivReceiverConfirmEvent = {
  name: "extensiv/receiver.confirm";
  data: {
    wmsEventId: string;
    receiverId: string;
    referenceNum: string;
    eventJson: ExtensivReceiverConfirmPayload;
    receivedAt: string;
  };
};

// ============================================================================
// ACTION EVENTS (Triggered by Battle Hub direct actions)
// ============================================================================
// These events are sent when CS/Ops users trigger actions from Battle Hub.
// They enable real-time tracking in the Live Runs panel.

export type ActionOrderCancelEvent = {
  name: "action/order.cancel";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    reason: string;
    email: boolean;
    refund: boolean;
    cancelledAt: string;
    source: "battle-hub";
  };
};

export type ActionOrderRefundEvent = {
  name: "action/order.refund";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    refundId?: string;
    amount: string | number;
    reason: string;
    restock: boolean;
    refundedAt: string;
    source: "battle-hub";
  };
};

export type ActionOrderFulfillEvent = {
  name: "action/order.fulfill";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    fulfillmentId?: string;
    fulfillmentType: string;
    platform: string;
    trackingNumber: string;
    carrier: string;
    fulfilledAt: string;
    source: "battle-hub";
  };
};

// Union type for all events
export type BattleBusEvents =
  | ShopifyOrderCreatedEvent
  | ShopifyRefundCreatedEvent
  | ShopifyOrderCancelledEvent
  | ShopifyOrderPaidEvent
  | ShopifyOrderUpdatedEvent
  | ShopifyOrderFulfilledEvent
  | GpsFulfilmentReceivedEvent
  | StordFulfilmentReceivedEvent
  | ExtensivOrderConfirmEvent
  | ExtensivReceiverConfirmEvent
  | ActionOrderCancelEvent
  | ActionOrderRefundEvent
  | ActionOrderFulfillEvent;

// ============================================================================
// PAYLOAD TYPES (Simplified - extend as needed from spock-store types)
// ============================================================================

export interface ShopifyOrderPayload {
  id: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  line_items: ShopifyLineItem[];
  shipping_address: ShopifyAddress | null;
  billing_address: ShopifyAddress | null;
  shipping_lines: ShopifyShippingLine[];
  discount_codes: ShopifyDiscountCode[];
  note: string | null;
  tags: string;
  customer: ShopifyCustomer | null;
  refunds: ShopifyRefund[];
  cancel_reason: keyof typeof CancelReasonEnum | null;
}

export interface ShopifyLineItem {
  id: number;
  variant_id: number | null;
  title: string;
  quantity: number;
  sku: string;
  variant_title: string | null;
  vendor: string | null;
  fulfillment_service: string;
  product_id: number | null;
  requires_shipping: boolean;
  taxable: boolean;
  gift_card: boolean;
  name: string;
  price: string;
  total_discount: string;
  fulfillment_status: string | null;
  properties: { name: string; value: string }[];
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyAddress {
  first_name: string;
  last_name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone: string | null;
  company: string | null;
  country_code: string;
  province_code: string;
}

export interface ShopifyShippingLine {
  id: number;
  title: string;
  price: string;
  code: string;
  source: string;
  carrier_identifier: string | null;
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyTaxLine {
  title: string;
  price: string;
  rate: number;
}

export interface ShopifyDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  tags: string;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyTransaction[];
}

export interface ShopifyRefundLineItem {
  id: number;
  quantity: number;
  line_item_id: number;
  line_item: ShopifyLineItem;
  subtotal: string;
  total_tax: string;
}

export interface ShopifyTransaction {
  id: number;
  kind: string;
  gateway: string;
  status: string;
  amount: string;
}

export interface ShopifyRefundPayload {
  id: number;
  order_id: number;
  created_at: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyTransaction[];
}

export interface GpsFulfilmentPayload {
  orderId: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  shippedDate: string;
  items: {
    sku: string;
    quantity: number;
  }[];
}

export interface StordFulfilmentPayload {
  orderId: string;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  shippedAt: string;
  lineItems: {
    sku: string;
    quantity: number;
  }[];
}

export interface ExtensivOrderConfirmPayload {
  referenceNum: string;
  readOnly: {
    orderId: number;
    customerIdentifier: { id: number; name: string };
    facilityIdentifier: { id: number; name: string };
    createdByIdentifier: { id: number; name: string };
  };
  routingInfo: {
    carrier: string;
    mode: string;
    trackingNumber: string;
  };
}

export interface ExtensivReceiverConfirmPayload {
  referenceNum: string;
  readOnly: {
    receiverId: number;
    customerIdentifier: { id: number; name: string };
    facilityIdentifier: { id: number; name: string };
  };
}

export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  created_at: string;
  updated_at: string;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_numbers: string[];
  tracking_url: string | null;
  tracking_urls: string[];
  location_id: number | null;
  line_items: ShopifyFulfillmentLineItem[];
}

export interface ShopifyFulfillmentLineItem {
  id: number;
  variant_id: number;
  title: string;
  quantity: number;
  sku: string;
  name: string;
  price: string;
  fulfillment_status: string;
}

export enum CancelReasonEnum {
  customer = 'The customer canceled the order',
  fraud = 'The order was fraudulent',
  inventory = 'Items in the order were not in inventory',
  declined = 'The payment was declined',
  other = 'Other reason',
}
